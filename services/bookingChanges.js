/**
 * Cancelling and rescheduling — the single write path for every surface.
 *
 * The client's manage link, the admin detail modal and the admin calendar's
 * drag-and-drop all call through here, so none of them can bypass the rules:
 *
 *   - cancelling is a STATE, never a delete: the row survives for the audit
 *     trail, refund handling and no-show tracking
 *   - a client may only change a booking more than `cancellationCutoffHours`
 *     ahead; an admin may always change it
 *   - inside the cutoff the commitment deposit is forfeited
 *   - rescheduling is ONE atomic operation — validate the new slot, then move.
 *     Never cancel-then-rebook as two user-driven steps: that is how people lose
 *     their slot and find the alternative already gone.
 */

const { checkSlot, reasonText } = require('./availability');
const { schedulingConfig, computeDuration, startOfUtcDay } = require('./scheduling');

const MS_PER_HOUR = 60 * 60 * 1000;

const CHANGE_REASON_TEXT = {
  'already-cancelled': 'This booking has already been cancelled.',
  'already-completed': 'This job has already been completed and cannot be changed.',
  'past-cutoff': 'This booking is too close to the service time to change online. Please call us.',
  'not-scheduled': 'This booking does not have a confirmed time yet.',
};

function changeReasonText(reason) {
  return CHANGE_REASON_TEXT[reason] || reasonText(reason);
}

// When the crew is due. Falls back to the requested day for custom jobs that the
// admin has not scheduled yet.
function serviceStart(booking) {
  if (booking.schedule && booking.schedule.startAt) return new Date(booking.schedule.startAt);
  return new Date(booking.bookingDate);
}

function hoursUntilService(booking, now = new Date()) {
  return (serviceStart(booking) - now) / MS_PER_HOUR;
}

/**
 * Whether a self-serve client change is allowed right now. Admin callers skip
 * this — they can always act, on the phone, on the client's behalf.
 */
function clientCanChange(booking, settings, now = new Date()) {
  const cfg = schedulingConfig(settings);
  if (booking.jobStatus === 'cancelled') return { ok: false, reason: 'already-cancelled' };
  if (booking.jobStatus === 'completed' || booking.jobCompleted) {
    return { ok: false, reason: 'already-completed' };
  }
  if (hoursUntilService(booking, now) < cfg.cancellationCutoffHours) {
    return { ok: false, reason: 'past-cutoff' };
  }
  return { ok: true, cutoffHours: cfg.cancellationCutoffHours };
}

/**
 * Cancel a booking. Idempotent: cancelling an already-cancelled booking is a
 * no-op success, so a double-tap or a retried request cannot corrupt anything.
 *
 * Mutates the booking; the caller saves and notifies.
 *
 * @param {String} by 'client' | 'admin' | 'system'
 */
function cancelBooking(booking, { by = 'client', reason = '', noShow = false } = {}, settings, now = new Date()) {
  if (booking.jobStatus === 'cancelled') return { ok: true, alreadyCancelled: true };
  if (booking.jobStatus === 'completed' || booking.jobCompleted) {
    return { ok: false, reason: 'already-completed' };
  }
  if (by === 'client') {
    const allowed = clientCanChange(booking, settings, now);
    if (!allowed.ok) return allowed;
  }

  const cfg = schedulingConfig(settings);
  const insideCutoff = hoursUntilService(booking, now) < cfg.cancellationCutoffHours;
  const paid = Number(booking.payment.amountPaid) || 0;

  // Inside the cutoff the slot is effectively lost, so the commitment deposit is
  // forfeited. Outside it, anything already collected is queued for refund —
  // Hubtel refunds are manual, so this only records the intent for the operator.
  const forfeited = insideCutoff && paid > 0;

  booking.jobStatus = noShow ? 'no_show' : 'cancelled';
  booking.cancellation = {
    cancelledAt: now,
    cancelledBy: by,
    reason: reason || undefined,
    depositForfeited: forfeited,
    refundStatus: paid > 0 ? (forfeited ? 'none' : 'pending') : 'none',
  };
  // A cancelled booking must stop occupying its slot even if a hold was live.
  booking.hold = { state: 'expired' };

  return { ok: true, forfeited, insideCutoff, refundDue: paid > 0 && !forfeited ? paid : 0 };
}

/**
 * Move a booking to a new start time. Atomic: the slot is validated first and the
 * booking is only touched once it is known to be free, so a failed reschedule
 * leaves the original slot untouched.
 *
 * Mutates the booking; the caller saves and notifies.
 *
 * @param {Date|String} startAt new start
 * @param {String} by 'client' | 'admin'
 */
async function rescheduleBooking(booking, startAt, { by = 'client' } = {}, settings, now = new Date()) {
  if (booking.jobStatus === 'cancelled') return { ok: false, reason: 'already-cancelled' };
  if (booking.jobStatus === 'completed' || booking.jobCompleted) {
    return { ok: false, reason: 'already-completed' };
  }
  if (by === 'client') {
    const allowed = clientCanChange(booking, settings, now);
    if (!allowed.ok) return allowed;
  }

  // Excluding itself matters: without it the booking's own slot would read as
  // occupied and every reschedule would be rejected.
  const verdict = await checkSlot(
    {
      startAt,
      lines: booking.tanks,
      latlng: { lat: booking.location.lat, lng: booking.location.lng },
      excludeId: booking._id,
      offGrid: by === 'admin',
    },
    settings
  );
  if (!verdict.ok) return verdict;

  const previous = booking.schedule && booking.schedule.startAt
    ? { startAt: booking.schedule.startAt, endAt: booking.schedule.endAt }
    : null;
  if (previous) {
    booking.scheduleHistory.push({
      startAt: previous.startAt,
      endAt: previous.endAt,
      changedAt: now,
      changedBy: by,
    });
  }

  booking.schedule = {
    startAt: verdict.startAt,
    endAt: verdict.endAt,
    windowEndAt: verdict.windowEndAt,
    durationMin: verdict.durationMin,
    assignedBy: by,
  };
  booking.bookingDate = startOfUtcDay(verdict.startAt);
  booking.jobStatus = 'scheduled';
  // Whatever the reason it was held, it now has a real slot.
  if (!booking.hold || booking.hold.state !== 'held') booking.hold = { state: 'confirmed' };

  return { ok: true, previous, schedule: booking.schedule };
}

/** Duration this booking's cart implies, for admin scheduling of custom jobs. */
function durationFor(booking, settings) {
  return computeDuration(booking.tanks, settings);
}

module.exports = {
  cancelBooking,
  rescheduleBooking,
  clientCanChange,
  hoursUntilService,
  serviceStart,
  durationFor,
  changeReasonText,
};
