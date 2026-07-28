const QRCode = require('qrcode');
const Counter = require('../models/Counter');
const env = require('../config/env');

const year = () => new Date().getFullYear();
const pad = (n) => String(n).padStart(4, '0');

// Assign a certificate number once, then reuse it.
async function ensureCertificateNumber(booking) {
  if (booking.certificate?.number) return booking.certificate.number;
  const seq = await Counter.next('certificate');
  const number = `HAC-${year()}-${pad(seq)}`;
  booking.certificate = booking.certificate || {};
  booking.certificate.number = number;
  return number;
}

async function ensureReceiptNumber(booking) {
  if (booking.receiptNumber) return booking.receiptNumber;
  const seq = await Counter.next('receipt');
  booking.receiptNumber = `RCP-${year()}-${pad(seq)}`;
  return booking.receiptNumber;
}

// QR that points at the booking page so the client can re-book.
async function rebookQrDataUrl() {
  try {
    return await QRCode.toDataURL(`${env.baseUrl}/`, { margin: 1, width: 160 });
  } catch (_) {
    return '';
  }
}

module.exports = { ensureCertificateNumber, ensureReceiptNumber, rebookQrDataUrl };
