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

// Pluggable entry point. `provider` comes from Settings (DB), so it can be
// switched to 'google' from the admin panel without a code change.
async function getDistanceKm(base, dest, provider = 'haversine') {
  if (!base || !dest || dest.lat == null || dest.lng == null) return 0;
  if (provider === 'google') return googleDistanceKm(base, dest);
  return haversine(base, dest);
}

module.exports = { getDistanceKm, haversine };
