const express = require('express');
const router = express.Router();

const Booking = require('../models/Booking');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { requireAdmin } = require('../middleware/auth');
const { ensureCertificateNumber, ensureReceiptNumber, rebookQrDataUrl } = require('../services/documents');
const { round2 } = require('../services/pricing');
const { schedulingConfig, startOfUtcDay, addDays, computeDuration } = require('../services/scheduling');
const { estimateTravelMinutes } = require('../services/distance');
const { cancelBooking, rescheduleBooking, changeReasonText } = require('../services/bookingChanges');
const {
  dispatchCancellationNotifications,
  dispatchRescheduleNotifications,
} = require('../services/notifications');

// Everything under /admin requires a logged-in admin.
router.use(requireAdmin);

// ---- Dashboard ----
router.get('/', async (req, res, next) => {
  try {
    const { status, job, q, from, to } = req.query;
    const filter = {};
    if (status) filter['payment.status'] = status;
    if (job === 'completed') filter.jobCompleted = true;
    if (job === 'pending') filter.jobCompleted = false;
    if (job === 'cancelled') filter.jobStatus = { $in: ['cancelled', 'no_show'] };

    // Service-date range, so the operator can pull up "this week".
    if (from || to) {
      filter.bookingDate = {};
      if (from) filter.bookingDate.$gte = startOfUtcDay(new Date(from));
      if (to) filter.bookingDate.$lt = addDays(startOfUtcDay(new Date(to)), 1);
    }
    if (q) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [{ clientName: rx }, { reference: rx }];
    }

    const bookings = await Booking.find(filter).sort({ createdAt: -1 }).limit(200);

    const stats = {
      total: await Booking.countDocuments(),
      unpaid: await Booking.countDocuments({ 'payment.status': 'unpaid' }),
      paid: await Booking.countDocuments({ 'payment.status': 'paid' }),
      // A cancelled booking is not outstanding work.
      pendingJobs: await Booking.countDocuments({
        jobCompleted: false,
        jobStatus: { $nin: ['cancelled', 'no_show'] },
      }),
      cancelled: await Booking.countDocuments({ jobStatus: { $in: ['cancelled', 'no_show'] } }),
    };

    // Custom-priced jobs the admin still has to place on the calendar.
    const unscheduled = await Booking.find({
      jobStatus: { $in: ['pending'] },
      'schedule.startAt': { $exists: false },
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      bookings,
      stats,
      unscheduled,
      query: req.query,
      cfg: await Settings.get(),
    });
  } catch (err) { next(err); }
});

// ---- Booking detail (fragment for modal expand) ----
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).send('Not found');
    res.render('admin/booking-detail', { booking, cfg: await Settings.get(), layout: false });
  } catch (err) { next(err); }
});

// ---- Payment confirmation ----
// Two flavours, keyed off whether Hubtel already settled the payment:
//  * Hubtel payment (money received via the callback, transactionId present):
//    admin confirmation is ONLY a human double-check. We flip confirmedManually
//    and KEEP the amount Hubtel reported — we never recompute from pricing.total.
//  * Cash / pay-on-site (no Hubtel transaction): admin confirms the amount by
//    hand (full or deposit), or resets back to unpaid.
router.patch('/bookings/:id/payment', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });

    const { mode } = req.body; // 'confirm' | 'unconfirm' | 'full' | 'deposit' | 'reset'
    const hubtelPaid = !!(booking.payment.hubtel && booking.payment.hubtel.transactionId);

    // Hubtel-settled: the online payment may cover only the transport DEPOSIT
    // (out-of-radius). Confirming means the admin has collected any on-site
    // balance in person, so it finalises the FULL amount (mirrors a cash full
    // confirm) — never a deposit-only stamp. Undo rolls back to exactly what
    // Hubtel settled (deposit or full). All hubtel.* fields are preserved so the
    // received-from-Hubtel amount keeps showing.
    if (hubtelPaid) {
      const depositAmount = booking.payment.hubtel.amount;
      const isDeposit = depositAmount != null && round2(depositAmount) < round2(booking.pricing.total);

      if (mode === 'confirm' || mode === 'full') {
        booking.payment.status = 'paid';
        booking.payment.amountPaid = booking.pricing.total;
        booking.payment.amountDue = 0;
        booking.payment.confirmedManually = true;
        booking.payment.confirmedBy = req.session.user.name;
        booking.payment.confirmedAt = new Date();
        await booking.save();
        return res.json({ ok: true, status: booking.payment.status });
      }
      // unconfirm / reset — roll back to Hubtel's settled state.
      booking.payment.confirmedManually = false;
      booking.payment.confirmedBy = undefined;
      booking.payment.confirmedAt = undefined;
      if (isDeposit) {
        booking.payment.status = 'deposit_paid';
        // Show the gross the client paid (with Hubtel's fee); bill the balance
        // against the requested deposit so the due matches the on-site amount.
        booking.payment.amountPaid = round2(booking.payment.hubtel.paidWithFees != null ? booking.payment.hubtel.paidWithFees : depositAmount);
        booking.payment.amountDue = round2(booking.pricing.total - depositAmount);
      } else {
        booking.payment.status = 'paid';
        booking.payment.amountPaid = round2(depositAmount != null ? depositAmount : booking.pricing.total);
        booking.payment.amountDue = 0;
      }
      await booking.save();
      return res.json({ ok: true, status: booking.payment.status });
    }

    // ---- Cash / pay-on-site ----
    if (mode === 'reset') {
      // Undo a confirmation — restore the unpaid state (and the transport tag).
      booking.payment.status = 'unpaid';
      booking.payment.amountPaid = 0;
      booking.payment.amountDue = booking.pricing.total;
      booking.payment.method = booking.payment.payNowChoice === 'now' ? 'hubtel' : 'none';
      booking.payment.confirmedManually = false;
      booking.payment.confirmedBy = undefined;
      booking.payment.confirmedAt = undefined;
      await booking.save();
      return res.json({ ok: true, status: booking.payment.status });
    }

    booking.payment.method = booking.payment.method === 'hubtel' ? 'hubtel' : 'cash';
    booking.payment.confirmedManually = true;
    booking.payment.confirmedBy = req.session.user.name;
    booking.payment.confirmedAt = new Date();

    if (mode === 'deposit') {
      booking.payment.status = 'deposit_paid';
      booking.payment.amountPaid = booking.transport.fee;
      booking.payment.amountDue = booking.pricing.total - booking.transport.fee;
    } else {
      booking.payment.status = 'paid';
      booking.payment.amountPaid = booking.pricing.total;
      booking.payment.amountDue = 0;
    }
    await booking.save();
    res.json({ ok: true, status: booking.payment.status });
  } catch (err) { next(err); }
});

// ---- Job completed toggle ----
router.patch('/bookings/:id/job', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });
    booking.jobCompleted = !booking.jobCompleted;
    // Un-completing a job with a slot puts it back on the calendar rather than
    // dropping it to 'pending', which now means 'not yet scheduled'.
    if (booking.jobCompleted) {
      booking.jobStatus = 'completed';
    } else {
      booking.jobStatus = booking.schedule && booking.schedule.startAt ? 'scheduled' : 'pending';
    }
    await booking.save();
    res.json({ ok: true, jobCompleted: booking.jobCompleted });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

// Colour vocabulary shared with the booking tiles so both tabs read as one UI.
function eventColour(b) {
  if (b.jobStatus === 'cancelled' || b.jobStatus === 'no_show') return '#c0392b';
  if (b.jobCompleted || b.jobStatus === 'completed') return '#7f8c9a';
  if (b.pricing && b.pricing.customPending) return '#8e44ad';
  if (b.payment && b.payment.status === 'unpaid') return '#f6a623';
  return '#1b9dd9';
}

// FullCalendar event feed. Travel/turnaround gaps are rendered as background
// events so the operator can SEE why an apparently free hour is not bookable.
// Each gap needs a drive-time lookup, so they are only computed for short
// ranges (day/week views) and skipped for a whole month.
router.get('/calendar/events', async (req, res, next) => {
  try {
    const settings = await Settings.get();
    const cfg = schedulingConfig(settings);
    const start = startOfUtcDay(new Date(req.query.start || Date.now()));
    const end = req.query.end ? new Date(req.query.end) : addDays(start, 7);

    const bookings = await Booking.find({ 'schedule.startAt': { $gte: start, $lt: end } })
      .sort({ 'schedule.startAt': 1 })
      .lean();

    const events = bookings.map((b) => ({
      id: String(b._id),
      title: b.clientName + ' — ' + (b.tanks || []).map((t) => t.quantity + 'x ' + t.label).join(', '),
      start: b.schedule.startAt,
      end: b.schedule.endAt,
      backgroundColor: eventColour(b),
      borderColor: eventColour(b),
      editable: !(b.jobCompleted || b.jobStatus === 'cancelled' || b.jobStatus === 'no_show'),
      extendedProps: {
        reference: b.reference,
        clientName: b.clientName,
        whatsapp: b.whatsapp,
        address: b.location && b.location.address,
        distanceKm: b.location && b.location.distanceKm,
        total: b.pricing && b.pricing.total,
        paymentStatus: b.payment && b.payment.status,
        jobStatus: b.jobStatus,
        durationMin: b.schedule.durationMin,
        windowEndAt: b.schedule.windowEndAt,
        customPending: !!(b.pricing && b.pricing.customPending),
      },
    }));

    const spanDays = Math.round((end - start) / (24 * 3600 * 1000));
    if (spanDays <= 14) {
      const live = bookings.filter((b) => b.jobStatus !== 'cancelled' && b.jobStatus !== 'no_show');
      const cache = new Map();
      const travel = async (a, z) => {
        const k = JSON.stringify([a && a.lat, a && a.lng, z && z.lat, z && z.lng]);
        if (!cache.has(k)) cache.set(k, await estimateTravelMinutes(a, z, settings));
        return cache.get(k);
      };

      for (let i = 0; i < live.length; i++) {
        const b = live[i];
        const next = live[i + 1];
        const sameDay = next &&
          startOfUtcDay(next.schedule.startAt).getTime() ===
          startOfUtcDay(b.schedule.startAt).getTime();
        const drive = sameDay
          ? await travel(b.location, next.location)
          : await travel(b.location, settings.baseLocation);
        const need = sameDay ? Math.max(drive, cfg.minTurnaroundMin) : drive;
        if (!need) continue;
        events.push({
          display: 'background',
          start: b.schedule.endAt,
          end: new Date(new Date(b.schedule.endAt).getTime() + need * 60000),
          backgroundColor: 'rgba(246,166,35,.18)',
          title: sameDay ? 'travel + turnaround' : 'return to base',
        });
      }
    }

    res.json(events);
  } catch (err) { next(err); }
});

// Shared write path for every reschedule: the client manage link, the detail
// modal and the calendar's drag-and-drop all land here, so none of them can
// place a job the availability engine would reject.
router.patch('/bookings/:id/schedule', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });
    const settings = await Settings.get();

    const result = await rescheduleBooking(booking, req.body.startAt, { by: 'admin' }, settings);
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: changeReasonText(result.reason) });
    }
    await booking.save();
    dispatchRescheduleNotifications(booking, settings, result.previous);
    res.json({ ok: true, schedule: booking.schedule });
  } catch (err) { next(err); }
});

router.patch('/bookings/:id/cancel', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });
    const settings = await Settings.get();

    const result = cancelBooking(
      booking,
      { by: 'admin', reason: req.body.reason, noShow: req.body.noShow === 'true' },
      settings
    );
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: changeReasonText(result.reason) });
    }
    if (!result.alreadyCancelled) {
      await booking.save();
      dispatchCancellationNotifications(booking, settings, 'admin');
    }
    res.json({ ok: true, jobStatus: booking.jobStatus, forfeited: !!result.forfeited });
  } catch (err) { next(err); }
});

// ---- Settle a custom quote (admin enters agreed prices, total recomputes) ----
router.patch('/bookings/:id/settle-quote', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });
    if (!booking.tanks.some((t) => t.custom)) return res.status(400).json({ ok: false, error: 'No custom tank to price.' });

    const settings = await Settings.get();

    // Apply the entered unit price to each custom tank line.
    booking.tanks.forEach((t, i) => {
      if (!t.custom) return;
      const price = parseFloat(req.body[`price_${i}`]);
      if (!Number.isFinite(price) || price < 0) return;
      t.unitPrice = price;
      t.lineTotal = round2(price * t.quantity);
    });

    // Recompute exactly as computeQuote does: subtotal → min call-out floor → + transport.
    const tanksSubtotal = round2(booking.tanks.reduce((s, t) => s + (t.lineTotal || 0), 0));
    const minCalloutApplied = tanksSubtotal > 0 && tanksSubtotal < settings.minCallOutFee;
    const jobSubtotal = minCalloutApplied ? settings.minCallOutFee : tanksSubtotal;
    const total = round2(jobSubtotal + booking.transport.fee);

    booking.pricing.tanksSubtotal = tanksSubtotal;
    booking.pricing.minCalloutApplied = minCalloutApplied;
    booking.pricing.total = total;
    booking.pricing.customPending = false;
    booking.payment.amountDue = round2(total - booking.payment.amountPaid);

    await booking.save();
    res.json({ ok: true, total });
  } catch (err) { next(err); }
});

// ---- Save certificate fields ----
router.patch('/bookings/:id/certificate', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false });
    booking.certificate = booking.certificate || {};
    booking.certificate.freeChlorineResidual = req.body.freeChlorineResidual || booking.certificate.freeChlorineResidual;
    booking.certificate.technician = req.body.technician || booking.certificate.technician;
    if (req.body.nextServiceDue) booking.certificate.nextServiceDue = new Date(req.body.nextServiceDue);
    await booking.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Render certificate (print to PDF from browser) ----
router.get('/bookings/:id/certificate', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).send('Not found');
    const settings = await Settings.get();
    await ensureCertificateNumber(booking);
    if (!booking.certificate.issuedAt) booking.certificate.issuedAt = new Date();
    await booking.save();
    const qr = await rebookQrDataUrl();
    res.render('documents/certificate', { booking, cfg: settings, qr, layout: false });
  } catch (err) { next(err); }
});

// ---- Render receipt ----
router.get('/bookings/:id/receipt', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).send('Not found');
    const settings = await Settings.get();
    await ensureReceiptNumber(booking);
    await booking.save();
    const qr = await rebookQrDataUrl();
    res.render('documents/receipt', { booking, cfg: settings, qr, layout: false });
  } catch (err) { next(err); }
});

// ---- Change my password ----
router.post('/account/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const user = await User.findById(req.session.user.id);
    if (!user) {
      req.flash('error', 'Your session has expired. Please log in again.');
      return res.redirect('/admin/login');
    }
    if (!(await user.verifyPassword(currentPassword || ''))) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/settings');
    }
    if (!newPassword || newPassword.length < 10) {
      req.flash('error', 'New password must be at least 10 characters.');
      return res.redirect('/admin/settings');
    }
    if (newPassword !== confirmPassword) {
      req.flash('error', 'New password and confirmation do not match.');
      return res.redirect('/admin/settings');
    }
    if (newPassword === currentPassword) {
      req.flash('error', 'New password must be different from the current one.');
      return res.redirect('/admin/settings');
    }
    user.passwordHash = await User.hashPassword(newPassword);
    await user.save();
    req.flash('success', 'Password changed successfully.');
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
});

// ---- Settings ----
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await Settings.get();
    res.render('admin/settings', { title: 'Settings', cfg: settings });
  } catch (err) { next(err); }
});

router.post('/settings', async (req, res, next) => {
  try {
    const settings = await Settings.get();
    const b = req.body;

    // Keep the existing value when a field is missing or not a finite number,
    // so a malformed submit can never corrupt settings with NaN.
    const num = (v, fallback) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : fallback;
    };

    settings.baseLocation.name = b.baseName || settings.baseLocation.name;
    settings.baseLocation.lat = num(b.baseLat, settings.baseLocation.lat);
    settings.baseLocation.lng = num(b.baseLng, settings.baseLocation.lng);
    settings.freeRadiusKm = num(b.freeRadiusKm, settings.freeRadiusKm);
    settings.transportRatePerKm = num(b.transportRatePerKm, settings.transportRatePerKm);
    settings.minCallOutFee = num(b.minCallOutFee, settings.minCallOutFee);
    settings.distanceProvider = ['google', 'osrm'].includes(b.distanceProvider) ? b.distanceProvider : 'haversine';
    settings.adminNotifyNumber = b.adminNotifyNumber || '';
    settings.notificationsEnabled = b.notificationsEnabled === 'on';
    settings.commitmentDepositPct = num(b.commitmentDepositPct, settings.commitmentDepositPct);

    // ---- Scheduling ----
    const sc = settings.scheduling;
    const hhmm = (v, fallback) => (/^[0-9]{1,2}:[0-9]{2}$/.test(v || "") ? v : fallback);
    sc.workDayStart = hhmm(b.workDayStart, sc.workDayStart);
    sc.workDayEnd = hhmm(b.workDayEnd, sc.workDayEnd);

    // Checkboxes: an unticked day simply is not submitted.
    if (b.workingDays !== undefined) {
      const raw = Array.isArray(b.workingDays) ? b.workingDays : [b.workingDays];
      const days = raw.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6);
      if (days.length) sc.workingDays = days;
    }

    sc.slotStepMin = num(b.slotStepMin, sc.slotStepMin);
    sc.arrivalWindowMin = num(b.arrivalWindowMin, sc.arrivalWindowMin);
    sc.siteSetupMin = num(b.siteSetupMin, sc.siteSetupMin);
    sc.chlorineHoldMin = num(b.chlorineHoldMin, sc.chlorineHoldMin);
    sc.multiTankStaggerMin = num(b.multiTankStaggerMin, sc.multiTankStaggerMin);
    sc.minTurnaroundMin = num(b.minTurnaroundMin, sc.minTurnaroundMin);
    sc.travelSpeedKmh = num(b.travelSpeedKmh, sc.travelSpeedKmh);
    sc.travelRoadFactor = num(b.travelRoadFactor, sc.travelRoadFactor);
    sc.maxHorizonDays = num(b.maxHorizonDays, sc.maxHorizonDays);
    sc.maxJobsPerDay = num(b.maxJobsPerDay, sc.maxJobsPerDay);
    sc.holdTtlMinutes = num(b.holdTtlMinutes, sc.holdTtlMinutes);
    sc.holdingTankLitres = num(b.holdingTankLitres, sc.holdingTankLitres);
    sc.cancellationCutoffHours = num(b.cancellationCutoffHours, sc.cancellationCutoffHours);

    // A lead time below the cancellation cutoff would let a client book a slot
    // they are instantly unable to change online, so it is clamped up.
    sc.minLeadTimeHours = Math.max(
      num(b.minLeadTimeHours, sc.minLeadTimeHours),
      sc.cancellationCutoffHours
    );

    // Blackout dates arrive as one date per line.
    if (b.blackoutDates !== undefined) {
      sc.blackoutDates = String(b.blackoutDates)
        .split(new RegExp("[\r\n,]+"))
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => new Date(d))
        .filter((d) => !Number.isNaN(d.getTime()));
    }

    // Price list rows arrive as parallel arrays keyed by sizeKey.
    const prior = {};
    for (const row of settings.priceList || []) prior[row.sizeKey] = row;
    if (Array.isArray(b.sizeKey)) {
      settings.priceList = b.sizeKey.map((key, i) => ({
        sizeKey: key,
        label: b.label[i],
        capacityLitres: parseFloat(b.capacityLitres[i]) || 0,
        standardPrice: parseFloat(b.standardPrice[i]) || 0,
        preservePrice: parseFloat(b.preservePrice[i]) || 0,
        // Durations feed the availability engine. Falling back to the stored
        // row matters: without it a settings save would silently reset every
        // size to the schema default and wreck the schedule.
        standardCleanMin: num(
          b.standardCleanMin && b.standardCleanMin[i],
          (prior[key] && prior[key].standardCleanMin) || 30
        ),
        preserveCleanMin: num(
          b.preserveCleanMin && b.preserveCleanMin[i],
          (prior[key] && prior[key].preserveCleanMin) || 60
        ),
        custom: Array.isArray(b.custom) ? b.custom.includes(key) : false,
      }));
    }

    await settings.save();
    req.flash('success', 'Settings updated.');
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
});

module.exports = router;
