const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // role field present now so multi-admin / staff logins are a trivial future add.
  role: { type: String, enum: ['superadmin', 'admin', 'staff'], default: 'admin' },
}, { timestamps: true });

userSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 12);
};

// Seed a single admin from env if the collection is empty. Safe to call on every boot.
userSchema.statics.seedAdmin = async function (admin) {
  const count = await this.countDocuments();
  if (count > 0) return null;
  const passwordHash = await this.hashPassword(admin.password);
  const user = await this.create({
    name: admin.name,
    username: admin.username,
    passwordHash,
    role: 'superadmin',
  });
  console.log(`[seed] created initial admin user '${user.username}'`);
  return user;
};

module.exports = mongoose.model('User', userSchema, 'Users');
