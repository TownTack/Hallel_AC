const axios = require('axios');
const env = require('../config/env');

// ---- Channel abstraction ----------------------------------------------------
// Today: Hubtel SMS. Tomorrow: add a WhatsApp Cloud API sender with the same
// signature and switch on settings/channel — callers never change.
//
// Every send is fire-and-forget: wrapped in try/catch and logged. A failed SMS
// must NEVER block or roll back a saved booking.

// Normalise a Ghana number to international format (233XXXXXXXXX) for Hubtel.
function normaliseGh(number) {
  if (!number) return '';
  let n = String(number).replace(/[\s()-]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  if (n.startsWith('0')) n = '233' + n.slice(1);
  if (!n.startsWith('233') && n.length === 9) n = '233' + n;
  return n;
}

async function sendSms(to, message, settings) {
  const dest = normaliseGh(to);
  if (!dest) return { ok: false, reason: 'no-destination' };

  // If SMS credentials aren't configured yet, log and no-op (dev / pre-Hubtel).
  if (!env.sms.clientId || !env.sms.clientSecret) {
    console.log(`[sms:dry-run] -> ${dest}: ${message}`);
    return { ok: false, reason: 'sms-not-configured', dryRun: true };
  }

  try {
    // Hubtel Simple SEND SMS (POST + Basic auth + JSON) per the official docs.
    const auth = Buffer.from(`${env.sms.clientId}:${env.sms.clientSecret}`).toString('base64');
    const res = await axios.post(
      'https://sms.hubtel.com/v1/messages/send',
      { From: env.sms.senderId, To: dest, Content: message },
      { headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }, timeout: 8000 }
    );
    // status 0 = "request submitted successfully"
    const ok = res.data?.status === 0 || res.status === 201;
    if (!ok) console.error(`[sms] non-success to ${dest}:`, res.data?.status, res.data?.statusDescription);
    return { ok, data: res.data };
  } catch (err) {
    console.error(`[sms] failed to ${dest}:`, err.response?.data || err.message);
    return { ok: false, reason: err.message };
  }
}

function money(n) {
  return `GHS ${Number(n || 0).toFixed(2)}`;
}

// Ghana is UTC+0 year-round, and the scheduling engine works in UTC, so the
// UTC clock time IS the local wall-clock time the client will see.
function hhmm(date) {
  return new Date(date).toISOString().slice(11, 16);
}

// "Mon 07:15-08:00" — the arrival window promised to the client.
function arrivalWindow(booking) {
  const sch = booking.schedule;
  if (!sch || !sch.startAt) return null;
  const end = sch.windowEndAt || sch.startAt;
  return hhmm(sch.startAt) + "-" + hhmm(end);
}

// Tokenised self-serve link for cancelling or rescheduling. Kept short so the
// SMS stays within one segment.
function manageLink(booking) {
  if (!booking.reference || !booking.manageToken) return null;
  return env.baseUrl + "/b/" + booking.reference + "/" + booking.manageToken;
}

function bookingSummaryLine(booking) {
  const tanks = booking.tanks
    .map((t) => `${t.quantity}x ${t.label}`)
    .join(', ');
  const date = new Date(booking.bookingDate).toLocaleDateString('en-GB');
  return { tanks, date };
}

// Client confirmation SMS.
async function sendBookingConfirmation(booking, settings) {
  if (settings && settings.notificationsEnabled === false) return { ok: false, reason: 'disabled' };
  const { date } = bookingSummaryLine(booking);
  const ref = booking.reference || String(booking._id).slice(-6).toUpperCase();
  const totalLine = booking.pricing.customPending
    ? 'You will receive a call soon to scope out the total cost of the service.'
    : `Total ${money(booking.pricing.total)}.`;
  const win = arrivalWindow(booking);
  const when = win ? `${date} between ${win}` : date;
  const link = manageLink(booking);
  const msg =
    `Hallel AquaCare: booking received (ref ${ref}) for ${when}. ` +
    `${totalLine}` +
    (link ? ` Change or cancel: ${link}` : ` We'll be in touch.`);
  return sendSms(booking.whatsapp, msg, settings);
}

// Admin ping SMS.
async function notifyAdmin(booking, settings) {
  if (settings && settings.notificationsEnabled === false) return { ok: false, reason: 'disabled' };
  const to = settings?.adminNotifyNumber;
  if (!to) {
    console.log('[sms] no adminNotifyNumber set, skipping admin ping');
    return { ok: false, reason: 'no-admin-number' };
  }
  const { tanks, date } = bookingSummaryLine(booking);
  const totalLine = booking.pricing.customPending
    ? 'Custom quote — call client to scope the total cost.'
    : `Total ${money(booking.pricing.total)}.`;
  const win = arrivalWindow(booking);
  const msg =
    `New booking: ${booking.clientName} (${booking.whatsapp}) on ${date}` +
    (win ? ` at ${win}` : ' (time to be confirmed)') + `. ` +
    `${tanks}. ${totalLine}`;
  return sendSms(to, msg, settings);
}

// ---- Cancellation / reschedule -------------------------------------------

async function dispatchCancellationNotifications(booking, settings, by) {
  if (settings && settings.notificationsEnabled === false) return;
  const { date } = bookingSummaryLine(booking);
  const ref = booking.reference;
  const forfeited = booking.cancellation && booking.cancellation.depositForfeited;

  const clientMsg =
    `Hallel AquaCare: your booking ${ref} for ${date} has been cancelled.` +
    (forfeited
      ? ' As it was cancelled at short notice the commitment deposit is not refundable.'
      : ' Any deposit you paid will be refunded.') +
    ' Call us to rebook.';
  sendSms(booking.whatsapp, clientMsg, settings).catch((e) =>
    console.error('[sms] cancel client notify error', e.message));

  const to = settings && settings.adminNotifyNumber;
  if (!to) return;
  const win = arrivalWindow(booking);
  const adminMsg =
    `CANCELLED (${by}): ${booking.clientName} (${booking.whatsapp}), ref ${ref}, ` +
    `${date}${win ? ' ' + win : ''}. Slot is free again.`;
  sendSms(to, adminMsg, settings).catch((e) =>
    console.error('[sms] cancel admin notify error', e.message));
}

async function dispatchRescheduleNotifications(booking, settings, previous) {
  if (settings && settings.notificationsEnabled === false) return;
  const { date } = bookingSummaryLine(booking);
  const ref = booking.reference;
  const win = arrivalWindow(booking);
  const when = win ? `${date} between ${win}` : date;
  const link = manageLink(booking);

  const clientMsg =
    `Hallel AquaCare: booking ${ref} has been moved to ${when}.` +
    (link ? ` Change or cancel: ${link}` : '');
  sendSms(booking.whatsapp, clientMsg, settings).catch((e) =>
    console.error('[sms] reschedule client notify error', e.message));

  const to = settings && settings.adminNotifyNumber;
  if (!to) return;
  const was = previous && previous.startAt
    ? new Date(previous.startAt).toLocaleDateString('en-GB') + ' ' + hhmm(previous.startAt)
    : 'unscheduled';
  const adminMsg = `MOVED: ${booking.clientName}, ref ${ref}, ${was} -> ${when}.`;
  sendSms(to, adminMsg, settings).catch((e) =>
    console.error('[sms] reschedule admin notify error', e.message));
}

// Fire both without blocking the caller's response.
function dispatchBookingNotifications(booking, settings) {
  sendBookingConfirmation(booking, settings).catch((e) => console.error('[sms] client notify error', e.message));
  notifyAdmin(booking, settings).catch((e) => console.error('[sms] admin notify error', e.message));
}

module.exports = {
  sendSms,
  normaliseGh,
  sendBookingConfirmation,
  notifyAdmin,
  dispatchBookingNotifications,
  dispatchCancellationNotifications,
  dispatchRescheduleNotifications,
  arrivalWindow,
  manageLink,
  hhmm,
};
