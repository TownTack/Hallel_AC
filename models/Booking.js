const crypto = require('crypto');
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
  // The service DAY. Kept as the calendar date of schedule.startAt so every
  // existing view, document and SMS keeps working; schedule.startAt below is
  // the real source of truth for when the crew arrives.
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

  // ---- Scheduling (server-computed, source of truth) ----
  // Absolute times, never a position in a queue: cancelling an earlier job must
  // leave this one exactly where it is rather than dragging it forward.
  // Unset for custom-priced jobs, which the admin schedules by hand.
  schedule: {
    startAt: Date, // crew arrives
    endAt: Date, // startAt + durationMin
    windowEndAt: Date, // startAt + arrivalWindowMin — the window shown to the client
    durationMin: Number,
    travelMinFromPrev: Number, // informational: drive time from the preceding job
    assignedBy: { type: String, enum: ['client', 'admin'], default: 'client' },
  },

  // Slot reservation while the client is inside Hubtel checkout. Availability
  // treats a live hold as busy and an expired one as free, so an abandoned
  // checkout releases the slot instead of eating it forever.
  hold: {
    state: { type: String, enum: ['held', 'confirmed', 'expired'], default: 'held' },
    expiresAt: Date,
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
  // Cancelled is a state, never a delete: the row is kept for the audit trail,
  // refund handling and no-show tracking.
  jobStatus: {
    type: String,
    enum: ['pending', 'scheduled', 'completed', 'cancelled', 'no_show'],
    default: 'pending',
  },
  jobCompleted: { type: Boolean, default: false },

  cancellation: {
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ['client', 'admin', 'system'] },
    reason: String,
    depositForfeited: { type: Boolean, default: false },
    refundStatus: {
      type: String,
      enum: ['none', 'pending', 'refunded', 'credited'],
      default: 'none',
    },
  },

  // Every slot this booking has previously occupied, oldest first.
  scheduleHistory: [{
    startAt: Date,
    endAt: Date,
    changedAt: Date,
    changedBy: String,
  }],

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

  // Unguessable secret for the client-facing manage link (cancel / reschedule),
  // sent in the confirmation SMS. Set once via the pre-save hook.
  manageToken: { type: String, index: true },

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

// The availability engine reads a day of bookings by start time, the hold sweeper
// scans for expired holds, and the admin calendar queries a date range.
bookingSchema.index({ 'schedule.startAt': 1 });
bookingSchema.index({ bookingDate: 1 });
bookingSchema.index({ 'hold.expiresAt': 1 });

bookingSchema.pre('save', function () {
  if (!this.reference) this.reference = String(this._id).slice(-6).toUpperCase();
  if (!this.manageToken) this.manageToken = crypto.randomBytes(16).toString('hex');
});

module.exports = mongoose.model('Booking', bookingSchema, 'Bookings');
