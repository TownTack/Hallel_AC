const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Settings = require('../models/Settings');
const hubtel = require('../services/hubtel');
const { dispatchBookingNotifications } = require('../services/notifications');

// ---------------------------------------------------------------------------
// Hubtel Online Checkout (Redirect Checkout) server endpoints.
//   - POST /payment/webhook   : Hubtel's server-to-server callback (source of truth)
//   - GET  /payment/status/:id: success-page polling, with a live status-check fallback
//   - GET  /payment/cancel/:id: Hubtel cancellationUrl — drop the unpaid booking
// The customer's browser returns to /booking/success/:id (the checkout returnUrl)
// only on success, so there is no browser /callback route here.
// ---------------------------------------------------------------------------

// Fire the client + admin SMS once, when a Hubtel payment first lands. For online
// bookings the "booking received" SMS is deferred from booking-creation to here,
// so a cancelled/abandoned booking never notifies anyone.
async function notifyOnFirstPayment(booking, wasUnpaid) {
  if (wasUnpaid && booking.payment.status !== 'unpaid') {
    const settings = await Settings.get();
    dispatchBookingNotifications(booking, settings);
  }
}

// Hubtel server-to-server notification. Body uses PascalCase keys; ResponseCode
// '0000' + Data.Status Success/Paid means the transaction settled. We look the
// booking up by ClientReference (= booking._id) and reconcile idempotently.
// Always ack with 200 — Hubtel expects it and we never surface a 500 to them.
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.Data || {};
    const ref = data.ClientReference;

    if (body.ResponseCode === '0000' && ['Success', 'Paid'].includes(data.Status) && ref) {
      const booking = await Booking.findById(ref);
      if (booking) {
        const wasUnpaid = booking.payment.status === 'unpaid';
        hubtel.applyHubtelSuccess(booking, {
          amount: data.Amount,
          transactionId: data.CheckoutId,
          raw: body,
        });
        await booking.save();
        await notifyOnFirstPayment(booking, wasUnpaid);
      } else {
        console.warn('[hubtel:webhook] no booking for reference', ref);
      }
    }
  } catch (err) {
    console.error('[hubtel:webhook]', err.message);
  }
  res.sendStatus(200); // always acknowledge
});

// Polling endpoint for the success page. Returns the stored status; if the booking
// is still unpaid on a Hubtel payment, do a live status check (covers the "no
// callback within 5 minutes" case and local dev where Hubtel can't reach us).
// The status endpoint only answers whitelisted IPs, so failures are swallowed.
router.get('/status/:id', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });

    if (booking.payment.status === 'unpaid' && booking.payment.hubtel?.reference) {
      const check = await hubtel.checkStatus(booking.payment.hubtel.reference);
      if (check.ok && check.status === 'Paid') {
        hubtel.applyHubtelSuccess(booking, {
          amount: check.amount,
          transactionId: check.transactionId,
          raw: check.raw,
        });
        await booking.save();
        await notifyOnFirstPayment(booking, true);
      }
    }

    res.json({ ok: true, status: booking.payment.status });
  } catch (err) {
    console.error('[hubtel:status]', err.message);
    res.status(500).json({ ok: false });
  }
});

// Hubtel cancellation returns the browser here. The booking was created before
// the checkout redirect; since payment was cancelled we delete the still-unpaid,
// never-notified booking and send the client back to the form. Guarded so a
// genuinely paid booking (transactionId present) is never removed.
router.get('/cancel/:id', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (booking && booking.payment.status === 'unpaid' && !(booking.payment.hubtel && booking.payment.hubtel.transactionId)) {
      await booking.deleteOne();
    }
  } catch (err) {
    console.error('[hubtel:cancel]', err.message);
  }
  req.flash('error', 'Payment was cancelled, so your booking was not saved. Please book again when you are ready.');
  res.redirect('/');
});

module.exports = router;
