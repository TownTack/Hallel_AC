const { getDistanceKm } = require("./distance");

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Look up a size in the settings price list and return its unit price for the tier.
function unitPriceFor(settings, sizeKey, tier) {
  const item = settings.priceList.find((p) => p.sizeKey === sizeKey);
  if (!item) return null;
  const price = tier === "preserve" ? item.preservePrice : item.standardPrice;
  return { item, price };
}

/**
 * Authoritative quote calculation. Used by both POST /api/quote (live UI) and
 * POST /booking (persisted). The browser never computes money — it only displays
 * what this returns.
 *
 * @param {Object} params
 * @param {Array}  params.tanks    [{ sizeKey, quantity, tier }]  (tier is per-tank)
 * @param {String} params.tier     fallback tier when a tank omits its own
 * @param {Object} params.latlng   { lat, lng } | null
 * @param {Object} settings        Settings document
 */
async function computeQuote(
  { tanks = [], tier = "standard", latlng = null },
  settings,
) {
  const lines = [];
  let tanksSubtotal = 0;
  const hasCustom = [];

  for (const t of tanks) {
    const qty = Math.max(1, parseInt(t.quantity, 10) || 0);
    // Per-tank service type: the tank's own tier wins; fall back to the call-level default.
    const lineTier = (t.tier || tier) === "preserve" ? "preserve" : "standard";
    const found = unitPriceFor(settings, t.sizeKey, lineTier);
    if (!found) continue;
    const { item, price } = found;
    const lineTotal = round2(price * qty);
    tanksSubtotal += lineTotal;
    if (item.custom) hasCustom.push(item.label);
    lines.push({
      sizeKey: item.sizeKey,
      label: item.label,
      capacityLitres: item.capacityLitres,
      quantity: qty,
      tier: lineTier,
      unitPrice: price,
      lineTotal,
      custom: !!item.custom,
    });
  }

  tanksSubtotal = round2(tanksSubtotal);

  // Minimum call-out fee floor (business plan section 5).
  const minCalloutApplied =
    tanksSubtotal > 0 && tanksSubtotal < settings.minCallOutFee;
  const jobSubtotal = minCalloutApplied
    ? settings.minCallOutFee
    : tanksSubtotal;

  // ---- Transport fee by distance ----
  let distanceKm = 0;
  let extraKm = 0;
  let transportFee = 0;
  if (latlng && latlng.lat != null && latlng.lng != null) {
    distanceKm = await getDistanceKm(
      settings.baseLocation,
      latlng,
      settings.distanceProvider,
    );
    extraKm = Math.max(0, distanceKm - settings.freeRadiusKm);
    transportFee = round2(extraKm * 2 * settings.transportRatePerKm);
  }
  const free = transportFee === 0;

  const total = round2(jobSubtotal + transportFee);

  // ---- Pay-now rules ----
  // Every booking takes a commitment deposit: a pct of the job subtotal, which
  // secures the slot and is forfeited on a late cancellation. Outside the free
  // radius the transport fee is charged on TOP of it — the fee covers a real
  // cost (fuel), the deposit covers commitment, so they are not interchangeable.
  const depositPct = Number(settings.commitmentDepositPct) || 0;
  const commitmentDeposit = round2((jobSubtotal * depositPct) / 100);
  const mandatoryAmount = round2(transportFee + commitmentDeposit);
  const payNowRequired = mandatoryAmount > 0;

  return {
    lines,
    currency: "GHS",
    tanksSubtotal,
    minCalloutApplied,
    minCallOutFee: settings.minCallOutFee,
    jobSubtotal,
    distanceKm: round2(distanceKm),
    freeRadiusKm: settings.freeRadiusKm,
    ratePerKm: settings.transportRatePerKm,
    extraKm: round2(extraKm),
    transportFee,
    free,
    total,
    commitmentDepositPct: depositPct,
    commitmentDeposit,
    payNowRequired,
    mandatoryAmount,
    hasCustom, // labels of custom-priced sizes needing a manual quote
  };
}

module.exports = { computeQuote, unitPriceFor, round2 };
