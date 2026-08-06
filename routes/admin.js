const express = require('express');
const router = express.Router();

const Booking = require('../models/Booking');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { requireAdmin } = require('../middleware/auth');
const { ensureCertificateNumber, ensureReceiptNumber, rebookQrDataUrl } = require('../services/documents');
const { round2 } = require('../services/pricing');

// Everything under /admin requires a logged-in admin.
router.use(requireAdmin);

// ---- Dashboard ----
router.get('/', async (req, res, next) => {
  try {
    const { status, job, q } = req.query;
    const filter = {};
    if (status) filter['payment.status'] = status;
    if (job === 'completed') filter.jobCompleted = true;
    if (job === 'pending') filter.jobCompleted = false;
    if (q) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [{ clientName: rx }, { reference: rx }];
    }

    const bookings = await Booking.find(filter).sort({ createdAt: -1 }).limit(200);

    const stats = {
      total: await Booking.countDocuments(),
      unpaid: await Booking.countDocuments({ 'payment.status': 'unpaid' }),
      paid: await Booking.countDocuments({ 'payment.status': 'paid' }),
      pendingJobs: await Booking.countDocuments({ jobCompleted: false }),
    };

    res.render('admin/dashboard', { title: 'Admin Dashboard', bookings, stats, query: req.query });
  } catch (err) { next(err); }
});

// ---- Booking detail (fragment for modal expand) ----
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).send('Not found');
    res.render('admin/booking-detail', { booking, layout: false });
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

    // Hubtel-settled: confirm just stamps the double-check; amount stays as paid.
    // (The `hubtelPaid && full/reset` guards defend against a stale fragment
    // posting the cash-flow modes on a Hubtel booking — never wipe the amount.)
    if (mode === 'confirm' || (hubtelPaid && mode === 'full')) {
      booking.payment.confirmedManually = true;
      booking.payment.confirmedBy = req.session.user.name;
      booking.payment.confirmedAt = new Date();
      await booking.save();
      return res.json({ ok: true, status: booking.payment.status });
    }
    if (mode === 'unconfirm' || (hubtelPaid && mode === 'reset')) {
      booking.payment.confirmedManually = false;
      booking.payment.confirmedBy = undefined;
      booking.payment.confirmedAt = undefined;
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
    booking.jobStatus = booking.jobCompleted ? 'completed' : 'pending';
    await booking.save();
    res.json({ ok: true, jobCompleted: booking.jobCompleted });
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

    // Price list rows arrive as parallel arrays keyed by sizeKey.
    if (Array.isArray(b.sizeKey)) {
      settings.priceList = b.sizeKey.map((key, i) => ({
        sizeKey: key,
        label: b.label[i],
        capacityLitres: parseFloat(b.capacityLitres[i]) || 0,
        standardPrice: parseFloat(b.standardPrice[i]) || 0,
        preservePrice: parseFloat(b.preservePrice[i]) || 0,
        custom: Array.isArray(b.custom) ? b.custom.includes(key) : false,
      }));
    }

    await settings.save();
    req.flash('success', 'Settings updated.');
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
});

module.exports = router;
