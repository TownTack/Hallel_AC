const mongoose = require("mongoose");

// Price list seeded from the business plan (section 5). Prices in GHS.
// `custom: true` means "from X / quote on request" — treated as a starting price.
const DEFAULT_PRICE_LIST = [
  {
    sizeKey: "nano500",
    label: "≤ 500 L (Nano / small)",
    capacityLitres: 500,
    standardPrice: 120,
    preservePrice: 200,
    standardCleanMin: 10,
    preserveCleanMin: 20,
    custom: false,
  },
  {
    sizeKey: "sumo1000",
    label: "750 – 1,000 L (Sumo-100 / Hippo 1000)",
    capacityLitres: 1000,
    standardPrice: 180,
    preservePrice: 280,
    standardCleanMin: 15,
    preserveCleanMin: 30,
    custom: false,
  },
  {
    sizeKey: "sumo1500",
    label: "1,500 L (Sumo-150)",
    capacityLitres: 1500,
    standardPrice: 230,
    preservePrice: 340,
    standardCleanMin: 18,
    preserveCleanMin: 36,
    custom: false,
  },
  {
    sizeKey: "sumo2000",
    label: "2,000 L (Sumo-200 / Hippo 2000)",
    capacityLitres: 2000,
    standardPrice: 280,
    preservePrice: 400,
    standardCleanMin: 20,
    preserveCleanMin: 40,
    custom: false,
  },
  {
    sizeKey: "sumo2500",
    label: "2,500 L (Sumo-250)",
    capacityLitres: 2500,
    standardPrice: 330,
    preservePrice: 460,
    standardCleanMin: 23,
    preserveCleanMin: 46,
    custom: false,
  },
  {
    sizeKey: "sumo3000",
    label: "3,000 L (Sumo-300 / Hippo 3000)",
    capacityLitres: 3000,
    standardPrice: 380,
    preservePrice: 520,
    standardCleanMin: 25,
    preserveCleanMin: 50,
    custom: false,
  },
  {
    sizeKey: "hippo4000",
    label: "4,000 L (Hippo 4000)",
    capacityLitres: 4000,
    standardPrice: 480,
    preservePrice: 640,
    standardCleanMin: 28,
    preserveCleanMin: 56,
    custom: false,
  },
  {
    sizeKey: "rambo5000",
    label: "5,000 L (Rambo / Sumo Super)",
    capacityLitres: 5000,
    standardPrice: 580,
    preservePrice: 760,
    standardCleanMin: 30,
    preserveCleanMin: 60,
    custom: false,
  },
  {
    sizeKey: "rambo10000",
    label: "6,000 – 10,000 L (Rambo)",
    capacityLitres: 10000,
    standardPrice: 700,
    preservePrice: 950,
    standardCleanMin: 45,
    preserveCleanMin: 90,
    custom: true,
  },
  {
    sizeKey: "industrial",
    label: "> 10,000 L (industrial / underground)",
    capacityLitres: 15000,
    standardPrice: 0,
    preservePrice: 0,
    standardCleanMin: 60,
    preserveCleanMin: 120,
    custom: true,
  },
];

const priceItemSchema = new mongoose.Schema(
  {
    sizeKey: { type: String, required: true },
    label: { type: String, required: true },
    capacityLitres: { type: Number, required: true },
    standardPrice: { type: Number, default: 0 },
    preservePrice: { type: Number, default: 0 },
    // Active crew minutes to clean ONE tank of this size. Excludes the shared
    // site setup and the chlorine hold — see services/scheduling.js.
    standardCleanMin: { type: Number, default: 30 },
    preserveCleanMin: { type: Number, default: 60 },
    custom: { type: Boolean, default: false },
  },
  { _id: false },
);

const settingsSchema = new mongoose.Schema(
  {
    // Singleton guard: always the same _id so getSettings() finds one doc.
    key: { type: String, default: "primary", unique: true },

    baseLocation: {
      name: { type: String, default: "Emefs Hillview Palace Estate" },
      lat: { type: Number, default: 5.7513417961458435 }, // actual emefs base location
      lng: { type: Number, default: 0.006955032960084153 },
    },

    freeRadiusKm: { type: Number, default: 17 },
    transportRatePerKm: { type: Number, default: 6 }, // GHS per extra km
    minCallOutFee: { type: Number, default: 150 },
    quarterlyDiscountPct: { type: Number, default: 15 }, // future recurring

    // Commitment deposit taken on EVERY booking, as a pct of the job subtotal.
    // Outside the free radius it is charged on top of the transport fee.
    commitmentDepositPct: { type: Number, default: 10 },

    // One-time marker: the per-size cleaning durations were added to priceList
    // after the first settings docs existed. Mongoose fills subdocument defaults
    // on load, so a never-saved field is indistinguishable from a real value —
    // this flag is the only reliable way to know a doc still needs seeding.
    priceDurationsSeeded: { type: Boolean, default: false },

    // ---- Scheduling / availability ----
    // Every knob the availability engine uses; nothing is hardcoded in code.
    scheduling: {
      workDayStart: { type: String, default: "07:00" }, // crew leaves base
      workDayEnd: { type: String, default: "17:00" },   // crew back at base
      workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0=Sun..6=Sat
      blackoutDates: { type: [Date], default: [] },

      slotStepMin: { type: Number, default: 15 },      // candidate start granularity
      arrivalWindowMin: { type: Number, default: 45 }, // the promise: "7:00 - 7:45"

      // Duration model — see services/scheduling.js.
      siteSetupMin: { type: Number, default: 30 },
      chlorineHoldMin: { type: Number, default: 120 }, // crew waits on site
      multiTankStaggerMin: { type: Number, default: 90 },

      // Minimum gap between two clients. Covers the mandatory holding-tank and
      // hose sanitisation; travel time absorbs it whenever travel is longer.
      minTurnaroundMin: { type: Number, default: 60 },

      // Haversine gives straight-line km; these turn it into drive minutes.
      travelSpeedKmh: { type: Number, default: 25 },
      travelRoadFactor: { type: Number, default: 1.3 },

      // Must not be LESS than cancellationCutoffHours below, or a client could
      // book a slot they are immediately unable to change or cancel online.
      minLeadTimeHours: { type: Number, default: 24 },
      maxHorizonDays: { type: Number, default: 60 },
      maxJobsPerDay: { type: Number, default: 3 },

      holdTtlMinutes: { type: Number, default: 15 }, // checkout slot hold
      cancellationCutoffHours: { type: Number, default: 24 },

      // Single Rambo-700 on the tricycle: preserve cannot exceed this capacity.
      holdingTankLitres: { type: Number, default: 7000 },
    },

    distanceProvider: {
      type: String,
      enum: ["haversine", "google", "osrm"],
      default: "haversine",
    },

    priceList: { type: [priceItemSchema], default: DEFAULT_PRICE_LIST },

    // Notifications
    adminNotifyNumber: { type: String, default: "" }, // e.g. 233530551604
    notificationsEnabled: { type: Boolean, default: true },

    businessInfo: {
      name: { type: String, default: "Hallel AquaCare" },
      tagline: { type: String, default: "Water Tank Cleaning & Disinfection" },
      phone: { type: String, default: "053 055 1604" },
      subsidiaryOf: {
        type: String,
        default: "A subsidiary of Hallel Industries Limited",
      },
      address: { type: String, default: "Emefs Hillview Estates" },
    },
  },
  { timestamps: true },
);

// Copy the per-size cleaning durations from the defaults into a settings doc
// that predates them. Runs at most once per document (guarded by
// priceDurationsSeeded), so an operator who later tunes the minutes in
// /admin/settings is never overwritten. Returns true when the doc changed.
function seedPriceDurations(doc) {
  if (doc.priceDurationsSeeded) return false;
  for (const row of doc.priceList || []) {
    const seed = DEFAULT_PRICE_LIST.find((d) => d.sizeKey === row.sizeKey);
    if (!seed) continue; // an admin-added size keeps its schema defaults
    row.standardCleanMin = seed.standardCleanMin;
    row.preserveCleanMin = seed.preserveCleanMin;
  }
  doc.priceDurationsSeeded = true;
  return true;
}

// Always return the single settings document, creating it with defaults if missing.
settingsSchema.statics.get = async function () {
  let doc = await this.findOne({ key: "primary" });
  if (!doc) doc = await this.create({ key: "primary" });
  if (seedPriceDurations(doc)) await doc.save();
  return doc;
};

module.exports = mongoose.model("Settings", settingsSchema, "Settings");
module.exports.DEFAULT_PRICE_LIST = DEFAULT_PRICE_LIST;
