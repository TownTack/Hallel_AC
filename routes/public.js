const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const Settings = require('../models/Settings');
const Booking = require('../models/Booking');
const { computeQuote, round2 } = require('../services/pricing');
const { getAvailableWindows, checkSlot, reasonText } = require('../services/availability');
const { schedulingConfig, computeDuration, startOfUtcDay, addDays, preserveOverCapacity } = require('../services/scheduling');
const {
  dispatchBookingNotifications,
  dispatchCancellationNotifications,
  dispatchRescheduleNotifications,
  normaliseGh,
} = require('../services/notifications');
const {
  cancelBooking,
  rescheduleBooking,
  clientCanChange,
  hoursUntilService,
  changeReasonText,
} = require('../services/bookingChanges');
const hubtel = require('../services/hubtel');
const { bookingRules, collect } = require('../middleware/validators');
const env = require('../config/env');

// Protect the write endpoints from abuse.
const bookingLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
const quoteLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
// Availability is polled as the client changes tanks/location, like the quote.
const availabilityLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
// The manage link is unguessable, but rate-limit it anyway so the token space
// cannot be probed.
const manageLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });

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
    scheduling: schedulingConfig(settings),
    commitmentDepositPct: settings.commitmentDepositPct,
  });
});

// ---- Live quote (JSON). Saves nothing; the price authority lives here. ----
router.post('/api/quote', quoteLimiter, async (req, res) => {
  try {
    const settings = await Settings.get();
    const tanks = parseTanks(req.body.tanks); // each tank carries its own tier
    const latlng = parseLatLng(req.body);
    const quote = await computeQuote({ tanks, latlng }, settings);
    res.json({ ok: true, quote });
  } catch (err) {
    console.error('[quote] error', err.message);
    res.status(400).json({ ok: false, error: 'Could not compute quote.' });
  }
});

// ---- Live availability (JSON). Stateless, like /api/quote: the browser renders
// what this returns and POST /booking re-validates whatever it sends back. ----
router.post('/api/availability', availabilityLimiter, async (req, res) => {
  try {
    const settings = await Settings.get();
    const tanks = parseTanks(req.body.tanks);
    const latlng = parseLatLng(req.body);

    // Price the cart first so durations are computed from the same canonical
    // lines the booking will store (unknown sizes are dropped by computeQuote).
    const quote = await computeQuote({ tanks, latlng }, settings);
    const cfg = schedulingConfig(settings);

    const today = startOfUtcDay(new Date());
    const from = req.body.from ? new Date(req.body.from) : today;
    const to = req.body.to ? new Date(req.body.to) : addDays(today, 30);

    const result = await getAvailableWindows(
      { lines: quote.lines, latlng, from, to },
      settings
    );

    res.json({
      ok: true,
      durationMin: result.durationMin,
      arrivalWindowMin: cfg.arrivalWindowMin,
      maxHorizonDays: cfg.maxHorizonDays,
      // Custom-priced tanks cannot be estimated, so they skip live availability
      // entirely and are scheduled by the admin after the quote is settled.
      customPending: quote.hasCustom.length > 0,
      days: result.days,
    });
  } catch (err) {
    console.error('[availability] error', err.message);
    res.status(400).json({ ok: false, error: 'Could not load availability.' });
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

    const tanks = parseTanks(req.body.tanks); // each tank carries its own tier
    const latlng = parseLatLng(req.body);

    // Recompute server-side — never trust amounts sent by the browser.
    const quote = await computeQuote({ tanks, latlng }, settings);
    if (!quote.lines.length) {
      req.flash('error', 'Please add at least one valid tank.');
      return res.redirect('/');
    }

    // A custom-priced tank means the total isn't settled yet — no online payment
    // is possible until the admin phones the client and settles the price.
    const customPending = quote.hasCustom.length > 0;
    const cfg = schedulingConfig(settings);

    // The crew carries a single Rambo-700 holding tank, so Clean & Preserve
    // cannot be offered for a tank whose contents will not fit in it.
    const oversized = preserveOverCapacity(quote.lines, settings);
    if (oversized.length) {
      req.flash('error',
        'Clean & Preserve is not available for ' + oversized.map((l) => l.label).join(', ') +
        ' — our holding tank is too small to store that much water. Please choose a Standard clean, or call us.');
      return res.redirect('/');
    }

    // ---- Slot ----
    // Whatever time the browser sends is a proposal; feasibility is decided
    // here, exactly as the quote is recomputed rather than trusted.
    // Custom-priced jobs have no estimable duration, so they skip availability
    // entirely (request-then-confirm) and the admin assigns the real slot.
    let slot = null;
    if (!customPending) {
      if (!req.body.startAt) {
        req.flash('error', 'Please choose an arrival window for your booking.');
        return res.redirect('/');
      }
      const verdict = await checkSlot(
        { startAt: req.body.startAt, lines: quote.lines, latlng },
        settings
      );
      if (!verdict.ok) {
        req.flash('error', reasonText(verdict.reason));
        return res.redirect('/');
      }
      slot = verdict;
    }

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
      tanks: quote.lines, // each line carries its own tier

      // Derived from the slot so the existing views, documents and SMS keep
      // working unchanged; custom jobs fall back to the requested day.
      bookingDate: slot ? startOfUtcDay(slot.startAt) : new Date(req.body.bookingDate),
      schedule: slot
        ? {
            startAt: slot.startAt,
            endAt: slot.endAt,
            windowEndAt: slot.windowEndAt,
            durationMin: slot.durationMin,
            assignedBy: 'client',
          }
        : undefined,
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
      // While the client is inside Hubtel checkout the slot is reserved but not
      // confirmed. If they abandon the tab the TTL lapses and the slot is freed
      // again — without this every abandoned checkout would eat a slot forever.
      hold: effectivePayNow
        ? { state: 'held', expiresAt: new Date(Date.now() + cfg.holdTtlMinutes * 60 * 1000) }
        : { state: 'confirmed' },
      jobStatus: slot && !effectivePayNow ? 'scheduled' : 'pending',
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
      // Nothing will come back to confirm the hold, so release it here or the
      // sweeper would cancel a perfectly good booking when the TTL lapses.
      booking.hold = { state: 'confirmed' };
      if (booking.schedule && booking.schedule.startAt) booking.jobStatus = 'scheduled';
      await booking.save();
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

// ---------------------------------------------------------------------------
// Self-serve manage link: /b/:reference/:token
// The token is generated per booking and sent in the confirmation SMS. Short
// path so the SMS stays within one segment.
// ---------------------------------------------------------------------------

async function findByToken(req) {
  const ref = String(req.params.reference || "").toUpperCase();
  const token = String(req.params.token || "");
  if (!ref || !token) return null;
  return Booking.findOne({ reference: ref, manageToken: token });
}

function notFound(res) {
  return res.status(404).render('error', {
    title: 'Not found',
    message: 'That booking link is not valid. Please check the link in your SMS.',
    status: 404,
  });
}

async function renderManage(req, res, booking) {
  const settings = await Settings.get();
  const cfg = schedulingConfig(settings);
  const allowed = clientCanChange(booking, settings);
  res.render('public/manage', {
    title: 'Manage your booking',
    booking,
    canChange: allowed.ok,
    blockedReason: allowed.ok ? null : changeReasonText(allowed.reason),
    cutoffHours: cfg.cancellationCutoffHours,
    hoursLeft: Math.max(0, Math.round(hoursUntilService(booking))),
    waNumber: normaliseGh(settings.businessInfo.phone),
  });
}

router.get('/b/:reference/:token', manageLimiter, async (req, res, next) => {
  try {
    const booking = await findByToken(req);
    if (!booking) return notFound(res);
    return renderManage(req, res, booking);
  } catch (err) {
    next(err);
  }
});

// Windows this booking could move to. Excludes itself, otherwise its own slot
// would read as occupied and nothing would ever be offered.
router.post('/b/:reference/:token/availability', manageLimiter, async (req, res) => {
  try {
    const booking = await findByToken(req);
    if (!booking) return res.status(404).json({ ok: false, error: 'Not found.' });
    const settings = await Settings.get();
    const today = startOfUtcDay(new Date());
    const result = await getAvailableWindows(
      {
        lines: booking.tanks,
        latlng: { lat: booking.location.lat, lng: booking.location.lng },
        from: req.body.from ? new Date(req.body.from) : today,
        to: req.body.to ? new Date(req.body.to) : addDays(today, 30),
        excludeId: booking._id,
      },
      settings
    );
    res.json({ ok: true, durationMin: result.durationMin, days: result.days });
  } catch (err) {
    console.error('[manage:availability]', err.message);
    res.status(400).json({ ok: false, error: 'Could not load availability.' });
  }
});

router.post('/b/:reference/:token/cancel', manageLimiter, async (req, res, next) => {
  try {
    const booking = await findByToken(req);
    if (!booking) return notFound(res);
    const settings = await Settings.get();

    const result = cancelBooking(booking, { by: 'client', reason: req.body.reason }, settings);
    if (!result.ok) {
      req.flash('error', changeReasonText(result.reason));
      return renderManage(req, res, booking);
    }
    if (!result.alreadyCancelled) {
      await booking.save();
      dispatchCancellationNotifications(booking, settings, 'client');
      req.flash('success', 'Your booking has been cancelled.');
    }
    return renderManage(req, res, booking);
  } catch (err) {
    next(err);
  }
});

router.post('/b/:reference/:token/reschedule', manageLimiter, async (req, res, next) => {
  try {
    const booking = await findByToken(req);
    if (!booking) return notFound(res);
    const settings = await Settings.get();

    const result = await rescheduleBooking(
      booking,
      req.body.startAt,
      { by: 'client' },
      settings
    );
    if (!result.ok) {
      req.flash('error', changeReasonText(result.reason));
      return renderManage(req, res, booking);
    }
    await booking.save();
    dispatchRescheduleNotifications(booking, settings, result.previous);
    req.flash('success', 'Your booking has been moved.');
    return renderManage(req, res, booking);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
