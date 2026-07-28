const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');

// ---------------------------------------------------------------------------
// Hubtel payment integration seam. Wired fully once official docs are provided.
// For now these endpoints exist so the app boots and the flow is testable; the
// cash / pay-on-site path works without them.
// ---------------------------------------------------------------------------

// Hubtel redirects the customer's browser back here after checkout.
router.get('/callback', async (req, res) => {
  // TODO(hubtel): verify status by reference, then mark booking paid/deposit.
  res.render('error', { title: 'Payment', message: 'Payment callback received (integration pending).', status: 200 });
});

// Hubtel server-to-server notification (source of truth). Verify signature here.
router.post('/webhook', express.json(), async (req, res) => {
  // TODO(hubtel): validate signature; look up booking by reference; update status.
  console.log('[hubtel:webhook] payload', JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});

// Optional polling endpoint for the success page.
router.get('/status/:id', async (req, res) => {
  const booking = await Booking.findById(req.params.id).select('payment');
  if (!booking) return res.status(404).json({ ok: false });
  res.json({ ok: true, status: booking.payment.status });
});

module.exports = router;
