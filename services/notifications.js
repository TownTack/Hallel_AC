const axios = require('axios');
const env = require('../config/env');

// ---- Channel abstraction ----------------------------------------------------
// Today: Hubtel SMS. Tomorrow: add a WhatsApp Cloud API sender with the same
// signature and switch on settings/channel — callers never change.
//
// Every send is fire-and-forget: wrapped in try/catch and logged. A failed SMS
// must NEVER block or roll back a saved booking.

// Normalise a Ghana number to international format (233XXXXXXXXX) for Hubtel.
function normaliseGh(number) {
  if (!number) return '';
  let n = String(number).replace(/[\s()-]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  if (n.startsWith('0')) n = '233' + n.slice(1);
  if (!n.startsWith('233') && n.length === 9) n = '233' + n;
  return n;
}

async function sendSms(to, message, settings) {
  const dest = normaliseGh(to);
  if (!dest) return { ok: false, reason: 'no-destination' };

  // If SMS credentials aren't configured yet, log and no-op (dev / pre-Hubtel).
  if (!env.sms.clientId || !env.sms.clientSecret) {
    console.log(`[sms:dry-run] -> ${dest}: ${message}`);
    return { ok: false, reason: 'sms-not-configured', dryRun: true };
  }

  try {
    // Hubtel Quick SMS endpoint (GET with basic auth via query is the documented
    // simple form; adjust when the official docs are provided).
    const res = await axios.get('https://smsc.hubtel.com/v1/messages/send', {
      params: {
        clientid: env.sms.clientId,
        clientsecret: env.sms.clientSecret,
        from: (settings?.businessInfo?.name && env.sms.senderId) || env.sms.senderId,
        to: dest,
        content: message,
      },
      timeout: 8000,
    });
    return { ok: true, data: res.data };
  } catch (err) {
    console.error(`[sms] failed to ${dest}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

function money(n) {
  return `GHS ${Number(n || 0).toFixed(2)}`;
}

function bookingSummaryLine(booking) {
  const tanks = booking.tanks
    .map((t) => `${t.quantity}x ${t.label}`)
    .join(', ');
  const date = new Date(booking.bookingDate).toLocaleDateString('en-GB');
  return { tanks, date };
}

// Client confirmation SMS.
async function sendBookingConfirmation(booking, settings) {
  if (settings && settings.notificationsEnabled === false) return { ok: false, reason: 'disabled' };
  const { date } = bookingSummaryLine(booking);
  const ref = String(booking._id).slice(-6).toUpperCase();
  const msg =
    `Hallel AquaCare: booking received (ref ${ref}) for ${date}. ` +
    `Total ${money(booking.pricing.total)}. We'll be in touch. Thank you!`;
  return sendSms(booking.whatsapp, msg, settings);
}

// Admin ping SMS.
async function notifyAdmin(booking, settings) {
  if (settings && settings.notificationsEnabled === false) return { ok: false, reason: 'disabled' };
  const to = settings?.adminNotifyNumber;
  if (!to) {
    console.log('[sms] no adminNotifyNumber set, skipping admin ping');
    return { ok: false, reason: 'no-admin-number' };
  }
  const { tanks, date } = bookingSummaryLine(booking);
  const msg =
    `New booking: ${booking.clientName} (${booking.whatsapp}) on ${date}. ` +
    `${tanks}. Total ${money(booking.pricing.total)}.`;
  return sendSms(to, msg, settings);
}

// Fire both without blocking the caller's response.
function dispatchBookingNotifications(booking, settings) {
  sendBookingConfirmation(booking, settings).catch((e) => console.error('[sms] client notify error', e.message));
  notifyAdmin(booking, settings).catch((e) => console.error('[sms] admin notify error', e.message));
}

module.exports = {
  sendSms,
  normaliseGh,
  sendBookingConfirmation,
  notifyAdmin,
  dispatchBookingNotifications,
};
