const mongoose = require('mongoose');

// Price list seeded from the business plan (section 5). Prices in GHS.
// `custom: true` means "from X / quote on request" — treated as a starting price.
const DEFAULT_PRICE_LIST = [
  { sizeKey: 'nano500', label: '≤ 500 L (Nano / small)', capacityLitres: 500, standardPrice: 120, preservePrice: 200, custom: false },
  { sizeKey: 'sumo1000', label: '750 – 1,000 L (Sumo-100 / Hippo 1000)', capacityLitres: 1000, standardPrice: 180, preservePrice: 280, custom: false },
  { sizeKey: 'sumo1500', label: '1,500 L (Sumo-150)', capacityLitres: 1500, standardPrice: 230, preservePrice: 340, custom: false },
  { sizeKey: 'sumo2000', label: '2,000 L (Sumo-200 / Hippo 2000)', capacityLitres: 2000, standardPrice: 280, preservePrice: 400, custom: false },
  { sizeKey: 'sumo2500', label: '2,500 L (Sumo-250)', capacityLitres: 2500, standardPrice: 330, preservePrice: 460, custom: false },
  { sizeKey: 'sumo3000', label: '3,000 L (Sumo-300 / Hippo 3000)', capacityLitres: 3000, standardPrice: 380, preservePrice: 520, custom: false },
  { sizeKey: 'hippo4000', label: '4,000 L (Hippo 4000)', capacityLitres: 4000, standardPrice: 480, preservePrice: 640, custom: false },
  { sizeKey: 'rambo5000', label: '5,000 L (Rambo / Sumo Super)', capacityLitres: 5000, standardPrice: 580, preservePrice: 760, custom: false },
  { sizeKey: 'rambo10000', label: '6,000 – 10,000 L (Rambo)', capacityLitres: 10000, standardPrice: 700, preservePrice: 950, custom: true },
  { sizeKey: 'industrial', label: '> 10,000 L (industrial / underground)', capacityLitres: 15000, standardPrice: 0, preservePrice: 0, custom: true },
];

const priceItemSchema = new mongoose.Schema({
  sizeKey: { type: String, required: true },
  label: { type: String, required: true },
  capacityLitres: { type: Number, required: true },
  standardPrice: { type: Number, default: 0 },
  preservePrice: { type: Number, default: 0 },
  custom: { type: Boolean, default: false },
}, { _id: false });

const settingsSchema = new mongoose.Schema({
  // Singleton guard: always the same _id so getSettings() finds one doc.
  key: { type: String, default: 'primary', unique: true },

  baseLocation: {
    name: { type: String, default: 'Emefs Hillview Palace Estate' },
    lat: { type: Number, default: 5.7167 },   // approx Accra; admin should refine
    lng: { type: Number, default: -0.2 },
  },

  freeRadiusKm: { type: Number, default: 17 },
  transportRatePerKm: { type: Number, default: 6 },   // GHS per extra km
  minCallOutFee: { type: Number, default: 150 },
  quarterlyDiscountPct: { type: Number, default: 15 }, // future recurring

  distanceProvider: { type: String, enum: ['haversine', 'google'], default: 'haversine' },

  priceList: { type: [priceItemSchema], default: DEFAULT_PRICE_LIST },

  // Notifications
  adminNotifyNumber: { type: String, default: '' }, // e.g. 233530551604
  notificationsEnabled: { type: Boolean, default: true },

  businessInfo: {
    name: { type: String, default: 'Hallel AquaCare' },
    tagline: { type: String, default: 'Water Tank Cleaning & Disinfection' },
    phone: { type: String, default: '053 055 1604' },
    subsidiaryOf: { type: String, default: 'A subsidiary of Hallel Industries Limited' },
    address: { type: String, default: 'Emefs Hillview Estates' },
  },
}, { timestamps: true });

// Always return the single settings document, creating it with defaults if missing.
settingsSchema.statics.get = async function () {
  let doc = await this.findOne({ key: 'primary' });
  if (!doc) doc = await this.create({ key: 'primary' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema, 'Settings');
module.exports.DEFAULT_PRICE_LIST = DEFAULT_PRICE_LIST;
