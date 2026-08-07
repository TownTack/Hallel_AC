const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const Settings = require('../models/Settings');
const Booking = require('../models/Booking');
const { computeQuote, round2 } = require('../services/pricing');
const { dispatchBookingNotifications, normaliseGh } = require('../services/notifications');
const hubtel = require('../services/hubtel');
const { bookingRules, collect } = require('../middleware/validators');
const env = require('../config/env');

// Protect the write endpoints from abuse.
const bookingLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
const quoteLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

// Parse the tanks payload which may arrive as JSON string (form) or array (fetch).
function parseTanks(raw) {
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? arr : [];
}

function parseLatLng(body) {
  const lat = parseFloat(body.lat);
  const lng = parseFloat(body.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

// ---- Booking form ----
router.get('/', async (req, res) => {
  const settings = await Settings.get();
  res.render('public/booking', {
    title: 'Book a Tank Clean — Hallel AquaCare',
    priceList: settings.priceList,
    baseLocation: settings.baseLocation,
    freeRadiusKm: settings.freeRadiusKm,
  });
});

// ---- Live quote (JSON). Saves nothing; the price authority lives here. ----
router.post('/api/quote', quoteLimiter, async (req, res) => {
  try {
    const settings = await Settings.get();
    const tanks = parseTanks(req.body.tanks);
    const tier = req.body.serviceTier === 'preserve' ? 'preserve' : 'standard';
    const latlng = parseLatLng(req.body);
    const quote = await computeQuote({ tanks, tier, latlng }, settings);
    res.json({ ok: true, quote });
  } catch (err) {
    console.error('[quote] error', err.message);
    res.status(400).json({ ok: false, error: 'Could not compute quote.' });
  }
});

// ---- Create booking ----
router.post('/booking', bookingLimiter, bookingRules, async (req, res, next) => {
  try {
    const errors = collect(req);
    const settings = await Settings.get();
    if (errors) {
      req.flash('error', errors.join(' '));
      return res.redirect('/');
    }

    const tanks = parseTanks(req.body.tanks);
    const tier = req.body.serviceTier === 'preserve' ? 'preserve' : 'standard';
    const latlng = parseLatLng(req.body);

    // Recompute server-side — never trust amounts sent by the browser.
    const quote = await computeQuote({ tanks, tier, latlng }, settings);
    if (!quote.lines.length) {
      req.flash('error', 'Please add at least one valid tank.');
      return res.redirect('/');
    }

    // A custom-priced tank means the total isn't settled yet — no online payment
    // is possible until the admin phones the client and settles the price.
    const customPending = quote.hasCustom.length > 0;

    let payNowChoice = req.body.payNowChoice === 'now' ? 'now' : 'later';
    // Outside radius forces the transport fee as a commitment deposit.
    let mustPayNow = quote.payNowRequired;
    if (customPending) {
      payNowChoice = 'later';
      mustPayNow = false;
    }
    const effectivePayNow = mustPayNow || payNowChoice === 'now';

    // Determine amounts for the payment record.
    let amountToPayNow = 0;
    if (effectivePayNow) {
      amountToPayNow = mustPayNow && payNowChoice !== 'now'
        ? quote.mandatoryAmount        // deposit only
        : quote.total;                 // full amount
    }

    const booking = await Booking.create({
      clientName: req.body.clientName,
      whatsapp: req.body.whatsapp,
      email: req.body.email || undefined,
      serviceTier: tier,
      tanks: quote.lines,
      bookingDate: new Date(req.body.bookingDate),
      location: {
        address: req.body.address || '',
        lat: latlng?.lat,
        lng: latlng?.lng,
        distanceKm: quote.distanceKm,
      },
      transport: {
        free: quote.free,
        extraKm: quote.extraKm,
        ratePerKm: quote.ratePerKm,
        fee: quote.transportFee,
      },
      pricing: {
        tanksSubtotal: quote.tanksSubtotal,
        minCalloutApplied: quote.minCalloutApplied,
        transportFee: quote.transportFee,
        total: quote.total,
        customPending,
      },
      payment: {
        method: effectivePayNow ? 'hubtel' : 'none',
        payNowChoice,
        status: 'unpaid',
        amountPaid: 0,
        amountDue: quote.total,
      },
    });

    // Online payment: create a Hubtel checkout and redirect the browser to the
    // hosted page. clientReference = booking._id (24-char ObjectId, within Hubtel's
    // 32-char limit) so the callback / status check / cancel resolve via findById.
    if (effectivePayNow) {
      const ref = booking._id.toString();
      const result = await hubtel.createCheckout({
        amount: amountToPayNow,
        description: `Hallel AquaCare booking ${ref}`,
        clientReference: ref,
        returnUrl: `${env.baseUrl}/booking/success/${ref}`,
        cancellationUrl: `${env.baseUrl}/payment/cancel/${ref}`,
        callbackUrl: `${env.baseUrl}/payment/webhook`,
        payee: { name: booking.clientName, mobile: booking.whatsapp, email: booking.email },
      });

      if (result.ok) {
        booking.payment.hubtel.reference = ref;
        booking.payment.hubtel.checkoutId = result.checkoutId;
        booking.payment.hubtel.checkoutUrl = result.checkoutUrl;
        booking.payment.hubtel.amount = round2(amountToPayNow);
        await booking.save();
        // NOTE: notifications are deferred to the payment callback
        // (routes/payment.js), so a cancelled booking never notifies anyone.
        return res.redirect(result.checkoutUrl); // leave site → Hubtel hosted page
      }

      // Dry-run (creds unset) or API failure: no online payment will happen, so
      // treat like a normal booking — notify now and show the success page.
      dispatchBookingNotifications(booking, settings);
      req.flash('success', `Booking received. Please pay ${amountToPayNow.toFixed(2)} GHS to confirm.`);
      return res.redirect(`/booking/success/${booking._id}`);
    }

    // Cash / pay-later: notify immediately (no online payment step).
    dispatchBookingNotifications(booking, settings);
    return res.redirect(`/booking/success/${booking._id}`);
  } catch (err) {
    next(err);
  }
});

// ---- Success page ----
router.get('/booking/success/:id', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).render('error', { title: 'Not found', message: 'Booking not found', status: 404 });
    const settings = await Settings.get();
    // wa.me deep link so the client can also message the business directly.
    // WhatsApp only accepts the full international number (233…) with no + or
    // leading 0, so normalise via the same helper the SMS sender uses.
    const waNumber = normaliseGh(settings.businessInfo.phone);
    res.render('public/success', { title: 'Booking Confirmed', booking, waNumber, baseUrl: env.baseUrl });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
