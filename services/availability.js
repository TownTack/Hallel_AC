/**
 * Availability engine — server-authoritative, exactly like services/pricing.js.
 *
 * The browser renders whatever this returns; POST /booking recomputes feasibility
 * and can reject. A start time sent by the client is always a proposal.
 *
 * A candidate start survives when all of these hold:
 *   - it is a working day, not blacked out, inside the horizon and past the lead time
 *   - the job fits between the day's open and close times
 *   - the day is under maxJobsPerDay
 *   - it does not overlap an existing job
 *   - the gap to the job before/after is at least max(drive time, minTurnaroundMin) —
 *     travel absorbs the buffer, so a nearby client can take a gap a distant one cannot
 *   - if it is the first job, the crew can drive out from base after opening
 *   - if it is the last job, the crew can get back to base before closing
 *
 * A cancelled booking simply drops out of the busy query, so the hole it leaves is
 * re-offered automatically to anyone whose cart fits it. There is no backfill code.
 */

const Booking = require('../models/Booking');
const { estimateTravelMinutes } = require('./distance');
const {
  MS_PER_MIN,
  schedulingConfig,
  startOfUtcDay,
  addMinutes,
  addDays,
  toDateKey,
  formatHhmm,
  computeDuration,
  isWorkingDay,
  dayBounds,
} = require('./scheduling');

// Only these fields are needed to reason about the day.
const BUSY_FIELDS = 'schedule location clientName reference jobStatus hold';

/**
 * Bookings that currently occupy a slot: live jobs, plus checkout holds that have
 * not yet expired. A `held` booking whose TTL has passed is treated as free, which
 * is what stops an abandoned Hubtel checkout from eating the slot forever.
 * Legacy bookings have no `hold` at all — `$ne` matches a missing field, so they
 * correctly count as busy.
 */
function busyClause(now) {
  return {
    jobStatus: { $in: ['pending', 'scheduled'] },
    $or: [{ 'hold.state': { $ne: 'held' } }, { 'hold.expiresAt': { $gt: now } }],
  };
}

// Memoises drive times for one request. Matters for the google/osrm providers,
// where every estimate is a network call.
function makeTravelCache(settings) {
  const cache = new Map();
  const at = (p) =>
    p && p.lat != null ? Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5) : 'none';
  return async (from, to) => {
    const key = at(from) + '>' + at(to);
    if (!cache.has(key)) cache.set(key, await estimateTravelMinutes(from, to, settings));
    return cache.get(key);
  };
}

// Minutes past midnight UTC for a Date, relative to the given day.
function minutesInto(day, date) {
  return Math.round((new Date(date).getTime() - day.getTime()) / MS_PER_MIN);
}

/**
 * Build the feasibility predicate for one day. Returns null when the day is
 * unavailable outright (closed, blacked out, or already at the job ceiling).
 *
 * The returned `check(startMin)` is the single source of truth for "can this job
 * start here", used both to walk the slot grid and to validate one specific time.
 */
async function buildDayChecker(day, ctx) {
  const { settings, cfg, durationMin, latlng, now, dayBookings, travel } = ctx;

  if (!isWorkingDay(day, settings)) return null;
  if (dayBookings.length >= cfg.maxJobsPerDay) return null;

  const bounds = dayBounds(day, settings);
  const base = settings.baseLocation;

  // Precompute every drive time this day needs — at most maxJobsPerDay jobs, so
  // the candidate walk below stays synchronous.
  const travelFromBase = await travel(base, latlng);
  const travelToBase = await travel(latlng, base);

  const jobs = [];
  for (const b of dayBookings) {
    const startMin = minutesInto(day, b.schedule.startAt);
    const endMin = b.schedule.endAt
      ? minutesInto(day, b.schedule.endAt)
      : startMin + (b.schedule.durationMin || 0);
    jobs.push({
      startMin,
      endMin,
      travelIn: await travel(b.location, latlng), // their site -> ours
      travelOut: await travel(latlng, b.location), // ours -> their site
    });
  }

  // Nothing may be booked closer to now than the lead time.
  const leadCutoffMin = minutesInto(
    day,
    new Date(now.getTime() + cfg.minLeadTimeHours * 60 * MS_PER_MIN)
  );

  function check(startMin) {
    const endMin = startMin + durationMin;

    if (startMin < bounds.openMin) return { ok: false, reason: 'before-opening' };
    if (endMin > bounds.closeMin) return { ok: false, reason: 'past-closing' };
    if (startMin < leadCutoffMin) return { ok: false, reason: 'lead-time' };

    let hasEarlier = false;
    let hasLater = false;

    for (const j of jobs) {
      if (startMin < j.endMin && j.startMin < endMin) {
        return { ok: false, reason: 'overlaps-existing-job' };
      }
      if (endMin <= j.startMin) {
        hasLater = true;
        const need = Math.max(j.travelOut, cfg.minTurnaroundMin);
        if (j.startMin - endMin < need) {
          return { ok: false, reason: 'not-enough-time-before-next-job' };
        }
      } else {
        hasEarlier = true;
        const need = Math.max(j.travelIn, cfg.minTurnaroundMin);
        if (startMin - j.endMin < need) {
          return { ok: false, reason: 'not-enough-time-after-previous-job' };
        }
      }
    }

    // First job of the day: the crew still has to drive out from base.
    if (!hasEarlier && startMin - bounds.openMin < travelFromBase) {
      return { ok: false, reason: 'too-early-to-reach-you' };
    }
    // Last job of the day: the crew has to get back to base before closing.
    if (!hasLater && endMin + travelToBase > bounds.closeMin) {
      return { ok: false, reason: 'crew-cannot-return-to-base' };
    }

    return { ok: true };
  }

  return { check, bounds };
}

function windowAt(day, startMin, durationMin, cfg) {
  return {
    startAt: addMinutes(day, startMin),
    endAt: addMinutes(day, startMin + durationMin),
    windowEndAt: addMinutes(day, startMin + cfg.arrivalWindowMin),
    durationMin,
    label: formatHhmm(startMin) + ' – ' + formatHhmm(startMin + cfg.arrivalWindowMin),
  };
}

/**
 * Available arrival windows for a cart over a date range.
 *
 * @param {Array}  lines      quote.lines — [{ sizeKey, quantity, tier, capacityLitres }]
 * @param {Object} latlng     { lat, lng } of the client's site
 * @param {Date}   from       first day to consider
 * @param {Date}   to         last day to consider (inclusive)
 * @param {String} excludeId  booking to ignore (used when rescheduling itself)
 * @returns {Object} { durationMin, days: [{ date, windows: [...] }] }
 */
async function getAvailableWindows({ lines, latlng, from, to, excludeId }, settings) {
  const cfg = schedulingConfig(settings);
  const durationMin = computeDuration(lines, settings);
  const now = new Date();

  if (!durationMin || !latlng || latlng.lat == null || latlng.lng == null) {
    return { durationMin, days: [] };
  }

  // Clamp the requested range to today..horizon.
  const today = startOfUtcDay(now);
  const horizonEnd = addDays(today, cfg.maxHorizonDays);
  let first = startOfUtcDay(from || today);
  let last = startOfUtcDay(to || addDays(today, 30));
  if (first < today) first = today;
  if (last > horizonEnd) last = horizonEnd;
  if (last < first) return { durationMin, days: [] };

  // One query for the whole range, then grouped by day — not one query per day.
  const query = Object.assign(
    { 'schedule.startAt': { $gte: first, $lt: addDays(last, 1) } },
    busyClause(now)
  );
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await Booking.find(query)
    .sort({ 'schedule.startAt': 1 })
    .select(BUSY_FIELDS)
    .lean();

  const byDay = new Map();
  for (const b of existing) {
    const key = toDateKey(b.schedule.startAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(b);
  }

  const travel = makeTravelCache(settings);
  const days = [];

  for (let day = first; day <= last; day = addDays(day, 1)) {
    const key = toDateKey(day);
    const checker = await buildDayChecker(day, {
      settings,
      cfg,
      durationMin,
      latlng,
      now,
      dayBookings: byDay.get(key) || [],
      travel,
    });

    const windows = [];
    if (checker) {
      const { bounds } = checker;
      for (
        let startMin = bounds.openMin;
        startMin + durationMin <= bounds.closeMin;
        startMin += cfg.slotStepMin
      ) {
        if (checker.check(startMin).ok) {
          windows.push(windowAt(day, startMin, durationMin, cfg));
        }
      }
    }
    days.push({ date: key, windows });
  }

  return { durationMin, days };
}

/**
 * Re-validate one specific start time. Used by POST /booking, by both reschedule
 * paths and by the payment webhook, so no surface can bypass the rules above.
 *
 * `offGrid` lets the admin place a job at a time the public grid would not offer;
 * every other constraint still applies, only slot-grid alignment is relaxed.
 */
async function checkSlot({ startAt, lines, latlng, excludeId, offGrid }, settings) {
  const cfg = schedulingConfig(settings);
  const durationMin = computeDuration(lines, settings);
  const now = new Date();
  const start = new Date(startAt);

  if (!durationMin) return { ok: false, reason: 'empty-cart' };
  if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid-date' };
  if (!latlng || latlng.lat == null || latlng.lng == null) {
    return { ok: false, reason: 'no-location' };
  }
  if (start > addDays(startOfUtcDay(now), cfg.maxHorizonDays)) {
    return { ok: false, reason: 'beyond-horizon' };
  }

  const day = startOfUtcDay(start);
  const startMin = minutesInto(day, start);

  if (!offGrid) {
    const bounds = dayBounds(day, settings);
    if ((startMin - bounds.openMin) % cfg.slotStepMin !== 0) {
      return { ok: false, reason: 'not-an-offered-start-time' };
    }
  }

  const query = Object.assign(
    { 'schedule.startAt': { $gte: day, $lt: addDays(day, 1) } },
    busyClause(now)
  );
  if (excludeId) query._id = { $ne: excludeId };
  const dayBookings = await Booking.find(query)
    .sort({ 'schedule.startAt': 1 })
    .select(BUSY_FIELDS)
    .lean();

  const checker = await buildDayChecker(day, {
    settings,
    cfg,
    durationMin,
    latlng,
    now,
    dayBookings,
    travel: makeTravelCache(settings),
  });
  if (!checker) {
    return { ok: false, reason: dayBookings.length ? 'day-is-full' : 'not-a-working-day' };
  }

  const verdict = checker.check(startMin);
  if (!verdict.ok) return verdict;
  return Object.assign({ ok: true }, windowAt(day, startMin, durationMin, cfg));
}

// Human-readable text for a failed check, for flash messages and API errors.
const REASON_TEXT = {
  'empty-cart': 'Please add at least one tank before choosing a time.',
  'invalid-date': 'That service time is not valid.',
  'no-location': 'Please pick your service location on the map first.',
  'beyond-horizon': 'That date is too far ahead to book yet.',
  'not-an-offered-start-time': 'Please pick one of the offered arrival windows.',
  'not-a-working-day': 'We do not work on that day.',
  'day-is-full': 'That day is fully booked.',
  'before-opening': 'That is before we start work.',
  'past-closing': 'That job would not finish before we close.',
  'lead-time': 'That time is too soon — please choose a later slot.',
  'overlaps-existing-job': 'That time has just been taken.',
  'not-enough-time-before-next-job': 'That time has just been taken.',
  'not-enough-time-after-previous-job': 'That time has just been taken.',
  'too-early-to-reach-you': 'The crew cannot reach you that early.',
  'crew-cannot-return-to-base': 'That job would finish too late in the day.',
};

function reasonText(reason) {
  return REASON_TEXT[reason] || 'That time is no longer available.';
}

module.exports = { getAvailableWindows, checkSlot, reasonText, busyClause };
