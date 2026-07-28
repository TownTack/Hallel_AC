// Reset (or create) the admin login password from .env.
//
// The seed in models/User.js only creates an admin when the Users collection is
// EMPTY, so editing ADMIN_PASSWORD in .env does nothing once an admin exists.
// Run this to force the existing admin's password to match .env:
//
//   1. Set a strong, unique ADMIN_PASSWORD (and optionally ADMIN_USERNAME) in .env
//   2. npm run reset-admin
//
// It updates the matching user's password hash in place — no data is wiped.

const mongoose = require('mongoose');
const env = require('./../config/env');
const connectDB = require('./../config/db');
const User = require('./../models/User');

async function main() {
  const { username, password, name } = env.admin;

  if (!password || password.length < 10 || /^(admin123|change-me-now)$/i.test(password)) {
    console.error(
      '[reset-admin] Refusing to set a weak/default password.\n' +
      '              Put a strong, unique ADMIN_PASSWORD (10+ chars) in .env first.'
    );
    process.exit(1);
  }

  await connectDB();
  const passwordHash = await User.hashPassword(password);

  const existing = await User.findOne({ username: username.toLowerCase() });
  if (existing) {
    existing.passwordHash = passwordHash;
    await existing.save();
    console.log(`[reset-admin] Password updated for '${existing.username}'.`);
  } else {
    const user = await User.create({ name, username, passwordHash, role: 'superadmin' });
    console.log(`[reset-admin] No matching admin found — created '${user.username}'.`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[reset-admin] failed:', err.message);
  process.exit(1);
});
