/**
 * Checkout slot holds.
 *
 * POST /booking creates the Booking *before* redirecting to Hubtel, so between
 * that redirect and the payment landing there is a window where the slot must be
 * reserved but is not yet paid for. That reservation is `booking.hold`:
 *
 *   held      -> occupies the slot until hold.expiresAt
 *   confirmed -> payment landed (or no payment was ever required)
 *   expired   -> the client abandoned checkout; the slot is free again
 *
 * services/availability.js already ignores a lapsed hold when computing windows,
 * so correctness does not depend on the sweeper running. The sweeper exists to
 * make the state explicit and keep abandoned rows out of the admin's job lists.
 */

const Booking = require('../models/Booking');
const { checkSlot } = require('./availability');

/**
 * Cancel bookings whose hold lapsed without a payment. Safe to run concurrently
 * and safe to run often: the query only matches rows that are still held, still
 * unpaid and still live, so it is idempotent.
 *
 * @returns {Number} how many bookings were released
 */
async function sweepExpiredHolds(now = new Date()) {
  const result = await Booking.updateMany(
    {
      'hold.state': 'held',
      'hold.expiresAt': { $lt: now },
      'payment.status': 'unpaid',
      jobStatus: { $in: ['pending', 'scheduled'] },
    },
    {
      $set: {
        'hold.state': 'expired',
        jobStatus: 'cancelled',
        'cancellation.cancelledAt': now,
        'cancellation.cancelledBy': 'system',
        'cancellation.reason': 'Checkout was not completed before the slot hold expired.',
      },
    }
  );

  const n = result.modifiedCount || 0;
  if (n) console.log(`[holds] released ${n} abandoned checkout hold(s)`);
  return n;
}

/**
 * Turn a held slot into a confirmed one once money has landed.
 *
 * The slot is re-validated first. It should still be free — the hold was blocking
 * it — but a TTL can lapse moments before a slow callback arrives, in which case
 * someone else may have taken it. The payment is never rejected for this: we keep
 * the booking, drop it back to `pending`, and flag it so the operator reschedules
 * rather than silently double-booking the crew.
 *
 * Mutates the booking; the caller saves it.
 */
async function confirmHoldAfterPayment(booking, settings) {
  booking.hold = booking.hold || {};
  booking.hold.state = 'confirmed';
  booking.hold.expiresAt = undefined;

  // Custom-priced jobs have no slot yet — they stay pending for the admin.
  if (!booking.schedule || !booking.schedule.startAt) return { ok: true, scheduled: false };

  const verdict = await checkSlot(
    {
      startAt: booking.schedule.startAt,
      lines: booking.tanks,
      latlng: { lat: booking.location.lat, lng: booking.location.lng },
      excludeId: booking._id,
      offGrid: true,
    },
    settings
  );

  if (verdict.ok) {
    booking.jobStatus = 'scheduled';
    return { ok: true, scheduled: true };
  }

  booking.jobStatus = 'pending';
  const flag = 'NEEDS RESCHEDULING: the held slot was lost while payment was in progress.';
  if (!(booking.notes || '').includes('NEEDS RESCHEDULING')) {
    booking.notes = [flag, booking.notes].filter(Boolean).join('\n');
  }
  console.warn(`[holds] booking ${booking.reference} paid but lost its slot (${verdict.reason})`);
  return { ok: false, reason: verdict.reason };
}

module.exports = { sweepExpiredHolds, confirmHoldAfterPayment };
