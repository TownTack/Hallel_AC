const mongoose = require('mongoose');

const tankLineSchema = new mongoose.Schema({
  sizeKey: { type: String, required: true },
  label: { type: String, required: true },
  capacityLitres: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  // Service type chosen for THIS tank (per-tank since a booking may mix services).
  // No default: legacy tanks (saved before this field) stay undefined so views can
  // fall back to the booking-level serviceTier. New bookings always set it explicitly.
  tier: { type: String, enum: ['standard', 'preserve'] },
  unitPrice: { type: Number, required: true },
  lineTotal: { type: Number, required: true },
  custom: { type: Boolean, default: false },
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
  // Legacy per-booking field. Service type is now chosen per tank (tankLine.tier);
  // this remains only as a read fallback for bookings saved before that change.
  serviceTier: { type: String, enum: ['standard', 'preserve'] },
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
    // True while a custom-priced tank hasn't been settled by the admin yet.
    // While true, the total is not final — displays show a "call to scope" message.
    customPending: { type: Boolean, default: false },
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
      checkoutId: String,
      checkoutUrl: String,
      amount: Number, // amount we asked Hubtel to collect (deposit or full)
      paidWithFees: Number, // gross the client actually paid (our amount + Hubtel's fee)
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

  // Short human-facing code (last 6 of _id, uppercased) — quoted in the client
  // SMS and searchable in the admin dashboard. Set once via the pre-save hook.
  reference: { type: String, index: true },

  notes: String,
}, { timestamps: true });

// One-word service summary for list/success views: 'standard' | 'preserve' | 'mixed'.
// Falls back to the legacy per-booking serviceTier for old bookings without per-tank tier.
bookingSchema.virtual('serviceSummary').get(function () {
  const tiers = new Set((this.tanks || []).map(t => t.tier).filter(Boolean));
  if (tiers.size === 0) return this.serviceTier || 'standard';
  if (tiers.size === 1) return [...tiers][0];
  return 'mixed';
});

bookingSchema.pre('save', function () {
  if (!this.reference) this.reference = String(this._id).slice(-6).toUpperCase();
});

module.exports = mongoose.model('Booking', bookingSchema, 'Bookings');
