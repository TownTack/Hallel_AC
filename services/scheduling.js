/**
 * Job duration + calendar helpers.
 *
 * Duration is derived from the cart, never fixed per service:
 *
 *   duration = siteSetupMin + SUM(cleanMin per tank) + chlorineHoldMin
 *              + (tankCount - 1) * multiTankStaggerMin
 *
 * The crew waits on site through the chlorine contact time, so the hold is
 * billable crew time. With a two-person crew the next tank's setup overlaps the
 * previous tank's hold, which is what multiTankStaggerMin captures: with the
 * seeded defaults a Rambo-5000 site comes out at 3h / 5h / 7h for 1 / 2 / 3
 * tanks, matching the operator's measured times.
 *
 * All times are handled in UTC on purpose. Ghana is UTC+0 year-round with no
 * DST, so UTC and local wall-clock agree, and using UTC makes the engine behave
 * identically no matter which timezone the server happens to run in (Render is
 * UTC, a dev laptop may not be).
 */

const MS_PER_MIN = 60 * 1000;

// Settings.scheduling, with defensive fallbacks for a settings doc that predates it.
const DEFAULTS = {
  workDayStart: '07:00',
  workDayEnd: '17:00',
  workingDays: [1, 2, 3, 4, 5, 6],
  blackoutDates: [],
  slotStepMin: 15,
  arrivalWindowMin: 45,
  siteSetupMin: 30,
  chlorineHoldMin: 120,
  multiTankStaggerMin: 90,
  minTurnaroundMin: 60,
  travelSpeedKmh: 25,
  travelRoadFactor: 1.3,
  minLeadTimeHours: 12,
  maxHorizonDays: 60,
  maxJobsPerDay: 3,
  holdTtlMinutes: 15,
  cancellationCutoffHours: 24,
  holdingTankLitres: 7000,
};

function schedulingConfig(settings) {
  const raw = (settings && settings.scheduling) || {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = raw[key];
    const missing =
      v == null || (Array.isArray(v) && key === 'workingDays' && v.length === 0);
    out[key] = missing ? DEFAULTS[key] : v;
  }
  return out;
}

// "07:00" -> 420 minutes past midnight.
function parseHhmm(value, fallbackMinutes) {
  const m = typeof value === 'string' ? value.split(':') : [];
  const h = parseInt(m[0], 10);
  const min = parseInt(m[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallbackMinutes;
  return h * 60 + min;
}

// 420 -> "07:00"
function formatHhmm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Midnight UTC on the day containing `date`.
function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * MS_PER_MIN);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * MS_PER_MIN);
}

// YYYY-MM-DD in UTC — the wire format used by the availability API.
function toDateKey(date) {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

// Active crew minutes for one tank of this size at this service tier.
function cleanMinutesFor(settings, sizeKey, tier) {
  const item = (settings.priceList || []).find((p) => p.sizeKey === sizeKey);
  if (!item) return null;
  const min = tier === 'preserve' ? item.preserveCleanMin : item.standardCleanMin;
  return Number.isFinite(min) ? min : null;
}

/**
 * Total minutes the crew is occupied at one site.
 * @param {Array} lines quote.lines (or booking.tanks) — [{ sizeKey, quantity, tier }]
 * @returns {Number} minutes, or 0 when nothing priceable is in the cart
 */
function computeDuration(lines, settings) {
  const cfg = schedulingConfig(settings);
  let tankCount = 0;
  let activeMin = 0;

  for (const line of lines || []) {
    const qty = Math.max(1, parseInt(line.quantity, 10) || 0);
    const per = cleanMinutesFor(settings, line.sizeKey, line.tier);
    if (per == null) continue; // unknown size — priced out by computeQuote too
    tankCount += qty;
    activeMin += per * qty;
  }

  if (tankCount === 0) return 0;

  return Math.round(
    cfg.siteSetupMin +
      activeMin +
      cfg.chlorineHoldMin +
      (tankCount - 1) * cfg.multiTankStaggerMin
  );
}

// Sunday..Saturday membership plus the blackout list.
function isWorkingDay(date, settings) {
  const cfg = schedulingConfig(settings);
  const day = startOfUtcDay(date);
  if (!cfg.workingDays.includes(day.getUTCDay())) return false;
  const key = toDateKey(day);
  return !(cfg.blackoutDates || []).some((b) => toDateKey(b) === key);
}

// Open/close as Date objects on the given day.
function dayBounds(date, settings) {
  const cfg = schedulingConfig(settings);
  const day = startOfUtcDay(date);
  const openMin = parseHhmm(cfg.workDayStart, 7 * 60);
  const closeMin = parseHhmm(cfg.workDayEnd, 17 * 60);
  return {
    day,
    openMin,
    closeMin,
    opensAt: addMinutes(day, openMin),
    closesAt: addMinutes(day, closeMin),
  };
}

/**
 * A preserve job transfers the tank's water into the single Rambo-700 holding
 * tank, so it cannot be offered for a tank larger than that. Returns the
 * offending lines (empty when the cart is fine).
 */
function preserveOverCapacity(lines, settings) {
  const cfg = schedulingConfig(settings);
  return (lines || []).filter(
    (l) => l.tier === 'preserve' && Number(l.capacityLitres) > cfg.holdingTankLitres
  );
}

module.exports = {
  MS_PER_MIN,
  schedulingConfig,
  parseHhmm,
  formatHhmm,
  startOfUtcDay,
  addMinutes,
  addDays,
  toDateKey,
  cleanMinutesFor,
  computeDuration,
  isWorkingDay,
  dayBounds,
  preserveOverCapacity,
};
