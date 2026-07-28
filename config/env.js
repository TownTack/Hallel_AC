// Centralised, typed access to environment variables with sensible defaults.
// Load .env once, here, before anything else reads process.env.
require('dotenv').config();

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hallelAquaCareDB',
  dbName: 'hallelAquaCareDB',

  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret',

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
    name: process.env.ADMIN_NAME || 'Hallel Admin',
  },

  hubtel: {
    clientId: process.env.HUBTEL_CLIENT_ID || '',
    clientSecret: process.env.HUBTEL_CLIENT_SECRET || '',
    merchantAccount: process.env.HUBTEL_MERCHANT_ACCOUNT || '',
    callbackUrl: process.env.HUBTEL_CALLBACK_URL || '',
  },

  sms: {
    clientId: process.env.HUBTEL_SMS_CLIENT_ID || '',
    clientSecret: process.env.HUBTEL_SMS_CLIENT_SECRET || '',
    senderId: process.env.HUBTEL_SMS_SENDER_ID || 'HallelAqua',
  },

  distanceProvider: process.env.DISTANCE_PROVIDER || 'haversine',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
};

env.isProd = env.nodeEnv === 'production';

module.exports = env;
