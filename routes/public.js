const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const Settings = require('../models/Settings');
const Booking = require('../models/Booking');
const { computeQuote } = require('../services/pricing');
const { dispatchBookingNotifications } = require('../services/notifications');
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

    const payNowChoice = req.body.payNowChoice === 'now' ? 'now' : 'later';
    // Outside radius forces the transport fee as a commitment deposit.
    const mustPayNow = quote.payNowRequired;
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
      },
      payment: {
        method: effectivePayNow ? 'hubtel' : 'none',
        payNowChoice,
        status: 'unpaid',
        amountPaid: 0,
        amountDue: quote.total,
      },
    });

    // Notify client + admin (fire-and-forget; never blocks).
    dispatchBookingNotifications(booking, settings);

    // TODO(payment): when Hubtel docs land, if effectivePayNow → create checkout
    // for `amountToPayNow` and redirect to the checkout URL. For now we record the
    // intent and proceed to the success page (cash / pay-on-site works fully).
    if (effectivePayNow) {
      req.flash('success', `Booking received. Please pay ${amountToPayNow.toFixed(2)} GHS to confirm (online payment coming soon).`);
    }

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
    const waNumber = (settings.businessInfo.phone || '').replace(/[^0-9]/g, '');
    res.render('public/success', { title: 'Booking Confirmed', booking, waNumber, baseUrl: env.baseUrl });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
