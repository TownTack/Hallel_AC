const axios = require('axios');
const env = require('../config/env');

// Great-circle (straight-line) distance in km between two {lat,lng} points.
function haversine(a, b) {
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Real driving distance via Google Distance Matrix (future upgrade). Falls back
// to haversine on any error so fee calculation never breaks.
async function googleDistanceKm(base, dest) {
  if (!env.googleMapsApiKey) return haversine(base, dest);
  try {
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
    const { data } = await axios.get(url, {
      params: {
        origins: `${base.lat},${base.lng}`,
        destinations: `${dest.lat},${dest.lng}`,
        key: env.googleMapsApiKey,
        units: 'metric',
      },
      timeout: 8000,
    });
    const meters = data?.rows?.[0]?.elements?.[0]?.distance?.value;
    if (typeof meters === 'number') return meters / 1000;
  } catch (err) {
    console.warn('[distance] google lookup failed, using haversine:', err.message);
  }
  return haversine(base, dest);
}

// Real driving distance via the public OSRM router — no API key, no cost.
// Falls back to haversine on any error/timeout so fee calculation never breaks.
async function osrmDistanceKm(base, dest) {
  try {
    // OSRM expects lng,lat order.
    const url = `https://router.project-osrm.org/route/v1/driving/` +
      `${base.lng},${base.lat};${dest.lng},${dest.lat}`;
    const { data } = await axios.get(url, {
      params: { overview: 'false' },
      timeout: 8000,
    });
    const meters = data?.routes?.[0]?.distance;
    if (typeof meters === 'number') return meters / 1000;
  } catch (err) {
    console.warn('[distance] osrm lookup failed, using haversine:', err.message);
  }
  return haversine(base, dest);
}

// Pluggable entry point. `provider` comes from Settings (DB), so it can be
// switched from the admin panel without a code change.
async function getDistanceKm(base, dest, provider = 'haversine') {
  if (!base || !dest || dest.lat == null || dest.lng == null) return 0;
  if (provider === 'google') return googleDistanceKm(base, dest);
  if (provider === 'osrm') return osrmDistanceKm(base, dest);
  return haversine(base, dest);
}

// Drive time in minutes between two points, used by the availability engine to
// decide whether the crew can actually get from one job to the next.
//
// Haversine returns a straight line, so it is scaled by travelRoadFactor before
// the average speed is applied. The google/osrm providers already return road
// distance, so they are not inflated a second time. If a provider ever exposes a
// real duration, this is the single place that has to change.
async function estimateTravelMinutes(from, to, settings) {
  if (!from || !to) return 0;
  if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) return 0;

  const cfg = (settings && settings.scheduling) || {};
  const speedKmh = cfg.travelSpeedKmh > 0 ? cfg.travelSpeedKmh : 25;
  const roadFactor = cfg.travelRoadFactor > 0 ? cfg.travelRoadFactor : 1.3;
  const provider = (settings && settings.distanceProvider) || "haversine";

  const km = await getDistanceKm(from, to, provider);
  const roadKm = provider === "haversine" ? km * roadFactor : km;
  return Math.round((roadKm / speedKmh) * 60);
}

module.exports = { getDistanceKm, haversine, estimateTravelMinutes };
