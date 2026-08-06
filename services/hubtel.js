const axios = require('axios');
const env = require('../config/env');
const { round2 } = require('./pricing');

// ---------------------------------------------------------------------------
// Hubtel Online Checkout (Redirect Checkout). Mirrors services/notifications.js:
// reads creds from config/env, uses axios, never throws to the caller (returns
// { ok, ... }), and dry-runs (logs + no-op) when credentials aren't configured
// so the cash / pay-on-site path keeps working without Hubtel.
// Docs: POST /items/initiate to create an invoice; GET /transactions/{acct}/status
// to poll (mandatory fallback when no callback arrives within 5 minutes).
// ---------------------------------------------------------------------------

const CHECKOUT_URL = 'https://payproxyapi.hubtel.com/items/initiate';
const STATUS_BASE = 'https://api-txnstatus.hubtel.com/transactions';

function authHeader() {
  const token = Buffer.from(`${env.hubtel.clientId}:${env.hubtel.clientSecret}`).toString('base64');
  return `Basic ${token}`;
}

// Hubtel rejects special characters in the description field.
function sanitizeDescription(text) {
  return String(text).replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 100);
}

// Create a hosted checkout invoice.
// Returns { ok, checkoutUrl, checkoutId, clientReference, raw } or { ok:false, ... }.
async function createCheckout({ amount, description, clientReference, returnUrl, cancellationUrl, callbackUrl, payee = {} }) {
  if (!env.hubtel.clientId || !env.hubtel.clientSecret || !env.hubtel.merchantAccount) {
    console.log(`[hubtel:dry-run] would create checkout ref=${clientReference} amount=${amount}`);
    return { ok: false, reason: 'hubtel-not-configured', dryRun: true };
  }

  try {
    const res = await axios.post(
      CHECKOUT_URL,
      {
        totalAmount: Number(Number(amount).toFixed(2)),
        description: sanitizeDescription(description),
        callbackUrl,
        returnUrl,
        cancellationUrl,
        merchantAccountNumber: env.hubtel.merchantAccount,
        clientReference,
        payeeName: payee.name,
        payeeMobileNumber: payee.mobile,
        payeeEmail: payee.email,
      },
      { headers: { 'Content-Type': 'application/json', Authorization: authHeader() }, timeout: 15000 }
    );

    const data = res.data?.data || {};
    if (res.data?.responseCode !== '0000' || !data.checkoutUrl) {
      console.error('[hubtel] initiate non-success', res.data?.responseCode, res.data?.status);
      return { ok: false, reason: `responseCode ${res.data?.responseCode}`, raw: res.data };
    }
    return {
      ok: true,
      checkoutUrl: data.checkoutUrl,
      checkoutId: data.checkoutId,
      clientReference: data.clientReference,
      raw: res.data,
    };
  } catch (err) {
    console.error('[hubtel] createCheckout failed:', err.response?.data || err.message);
    return { ok: false, reason: err.message };
  }
}

// Poll a transaction's status (fallback). NB: the endpoint only responds to IPs
// whitelisted by Hubtel — from anywhere else it returns 403 / times out, which we
// swallow. Returns { ok, status ('Paid'|'Unpaid'|'Refunded'), amount, transactionId, raw }.
async function checkStatus(clientReference) {
  if (!env.hubtel.clientId || !env.hubtel.merchantAccount) {
    return { ok: false, reason: 'hubtel-not-configured' };
  }
  try {
    const url = `${STATUS_BASE}/${env.hubtel.merchantAccount}/status`;
    const res = await axios.get(url, {
      params: { clientReference },
      headers: { Authorization: authHeader() },
      timeout: 15000,
    });
    const d = res.data?.data || {};
    return { ok: true, status: d.status, amount: d.amount, transactionId: d.transactionId, raw: res.data };
  } catch (err) {
    console.error('[hubtel] checkStatus failed:', err.response?.status || err.message);
    return { ok: false, reason: err.message };
  }
}

// Apply a confirmed Hubtel payment to a booking document. Idempotent: a booking
// already marked 'paid' is left untouched. Mirrors the manual-confirm math in
// routes/admin.js but leaves confirmedManually=false — the money arrived via
// Hubtel and the admin still does their own final confirmation. Caller saves.
function applyHubtelSuccess(booking, { amount, transactionId, raw }) {
  if (booking.payment.status === 'paid') return;

  const total = booking.pricing.total;
  const paid = round2(amount);

  booking.payment.method = 'hubtel';
  booking.payment.amountPaid = paid;
  if (paid >= total) {
    booking.payment.status = 'paid';
    booking.payment.amountDue = 0;
  } else {
    booking.payment.status = 'deposit_paid';
    booking.payment.amountDue = round2(total - paid);
  }
  booking.payment.hubtel.transactionId = transactionId;
  booking.payment.hubtel.raw = raw;
}

module.exports = { createCheckout, checkStatus, applyHubtelSuccess, sanitizeDescription };
