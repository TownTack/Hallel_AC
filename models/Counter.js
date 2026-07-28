const mongoose = require('mongoose');

// Simple atomic sequence generator. One document per named sequence.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'certificate', 'receipt'
  seq: { type: Number, default: 0 },
});

// Returns the next integer in the named sequence, atomically.
counterSchema.statics.next = async function (name) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
