const { getDistanceKm } = require('./distance');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Look up a size in the settings price list and return its unit price for the tier.
function unitPriceFor(settings, sizeKey, tier) {
  const item = settings.priceList.find((p) => p.sizeKey === sizeKey);
  if (!item) return null;
  const price = tier === 'preserve' ? item.preservePrice : item.standardPrice;
  return { item, price };
}

/**
 * Authoritative quote calculation. Used by both POST /api/quote (live UI) and
 * POST /booking (persisted). The browser never computes money — it only displays
 * what this returns.
 *
 * @param {Object} params
 * @param {Array}  params.tanks    [{ sizeKey, quantity }]
 * @param {String} params.tier     'standard' | 'preserve'
 * @param {Object} params.latlng   { lat, lng } | null
 * @param {Object} settings        Settings document
 */
async function computeQuote({ tanks = [], tier = 'standard', latlng = null }, settings) {
  const lines = [];
  let tanksSubtotal = 0;
  const hasCustom = [];

  for (const t of tanks) {
    const qty = Math.max(1, parseInt(t.quantity, 10) || 0);
    const found = unitPriceFor(settings, t.sizeKey, tier);
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
      unitPrice: price,
      lineTotal,
    });
  }

  tanksSubtotal = round2(tanksSubtotal);

  // Minimum call-out fee floor (business plan section 5).
  const minCalloutApplied = tanksSubtotal > 0 && tanksSubtotal < settings.minCallOutFee;
  const jobSubtotal = minCalloutApplied ? settings.minCallOutFee : tanksSubtotal;

  // ---- Transport fee by distance ----
  let distanceKm = 0;
  let extraKm = 0;
  let transportFee = 0;
  if (latlng && latlng.lat != null && latlng.lng != null) {
    distanceKm = await getDistanceKm(settings.baseLocation, latlng, settings.distanceProvider);
    extraKm = Math.max(0, distanceKm - settings.freeRadiusKm);
    transportFee = round2(extraKm * settings.transportRatePerKm);
  }
  const free = transportFee === 0;

  const total = round2(jobSubtotal + transportFee);

  // Pay-now rules: outside radius forces the transport fee as a commitment deposit.
  const payNowRequired = !free;
  const mandatoryAmount = free ? 0 : transportFee;

  return {
    lines,
    currency: 'GHS',
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
    payNowRequired,
    mandatoryAmount,
    hasCustom, // labels of custom-priced sizes needing a manual quote
  };
}

module.exports = { computeQuote, unitPriceFor, round2 };
