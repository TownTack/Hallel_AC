const mongoose = require('mongoose');
const env = require('./env');

// Ensure the connection targets the hallelAquaCareDB database even if the URI
// omits a db path (e.g. a bare host URI).
function resolveUri(uri) {
  // If the URI already has a database segment after the host, keep it.
  // Otherwise append the canonical db name.
  const hasDb = /\/[A-Za-z0-9_-]+(\?|$)/.test(uri.replace(/^mongodb(\+srv)?:\/\/[^/]+/, ''));
  if (hasDb) return uri;
  const sep = uri.includes('?') ? uri.replace('?', `/${env.dbName}?`) : `${uri.replace(/\/$/, '')}/${env.dbName}`;
  return sep;
}

async function connectDB() {
  const uri = resolveUri(env.mongoUri);
  mongoose.connection.on('connected', () => {
    console.log(`[db] connected to ${mongoose.connection.name}`);
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
  await mongoose.connect(uri, { dbName: env.dbName });
  return mongoose.connection;
}

module.exports = connectDB;
