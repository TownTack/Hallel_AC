const mongoose = require('mongoose');

const tankLineSchema = new mongoose.Schema({
  sizeKey: { type: String, required: true },
  label: { type: String, required: true },
  capacityLitres: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  lineTotal: { type: Number, required: true },
}, { _id: false });

const addOnSchema = new mongoose.Schema({
  sku: String,
  name: String,
  qty: Number,
  unitPrice: Number,
  lineTotal: Number,
}, { _id: false });

const bookingSchema = new mongoose.Schema({
  // ---- Client ----
  clientName: { type: String, required: true, trim: true },
  whatsapp: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },

  // ---- Service ----
  serviceTier: { type: String, enum: ['standard', 'preserve'], required: true },
  tanks: { type: [tankLineSchema], validate: v => Array.isArray(v) && v.length > 0 },
  bookingDate: { type: Date, required: true },

  // ---- Location & transport ----
  location: {
    address: String,
    lat: Number,
    lng: Number,
    distanceKm: Number,
  },
  transport: {
    free: { type: Boolean, default: true },
    extraKm: { type: Number, default: 0 },
    ratePerKm: { type: Number, default: 0 },
    fee: { type: Number, default: 0 },
  },

  // ---- Pricing (server-computed, source of truth) ----
  pricing: {
    tanksSubtotal: Number,
    minCalloutApplied: { type: Boolean, default: false },
    transportFee: Number,
    total: Number,
  },

  // ---- Payment ----
  payment: {
    method: { type: String, enum: ['hubtel', 'cash', 'none'], default: 'none' },
    payNowChoice: { type: String, enum: ['now', 'later'], default: 'later' },
    status: { type: String, enum: ['unpaid', 'deposit_paid', 'paid'], default: 'unpaid' },
    amountPaid: { type: Number, default: 0 },
    amountDue: { type: Number, default: 0 },
    hubtel: {
      reference: String,
      transactionId: String,
      checkoutUrl: String,
      raw: mongoose.Schema.Types.Mixed,
    },
    confirmedManually: { type: Boolean, default: false },
    confirmedBy: String,
    confirmedAt: Date,
  },

  // ---- Job lifecycle ----
  jobStatus: { type: String, enum: ['pending', 'scheduled', 'completed'], default: 'pending' },
  jobCompleted: { type: Boolean, default: false },

  // ---- Documents ----
  certificate: {
    number: String,
    freeChlorineResidual: String,
    nextServiceDue: Date,
    technician: String,
    issuedAt: Date,
  },
  receiptNumber: String,

  // ---- Future provisions (unused for now) ----
  addOns: { type: [addOnSchema], default: [] },
  plan: {
    recurring: { type: Boolean, default: false },
    interval: { type: String, enum: ['once', 'quarterly'], default: 'once' },
  },

  notes: String,
}, { timestamps: true });

module.exports = mongoose.model('Booking', bookingSchema, 'Bookings');
