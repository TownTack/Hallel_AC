const path = require('path');
const express = require('express');
const ejsMate = require('ejs-mate');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const flash = require('connect-flash');
const helmet = require('helmet');
const methodOverride = require('method-override');

const env = require('./config/env');
const connectDB = require('./config/db');
const Settings = require('./models/Settings');
const User = require('./models/User');

const app = express();

// Behind a reverse proxy / tunnel (cloudflared, and any prod reverse proxy) so
// req.ip, secure-cookie detection and express-rate-limit read X-Forwarded-For.
app.set('trust proxy', 1);

// ---- View engine (ejs-mate for layouts) ----
app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- Security headers with a CSP that allows our CDNs + OSM ----
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com', "'unsafe-inline'"],
        styleSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com', "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
        connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
        // Allow the booking form's POST to redirect out to Hubtel's hosted
        // checkout (Chrome enforces form-action against the redirect target).
        formAction: ["'self'", 'https://pay.hubtel.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ---- Body parsing & method override ----
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// ---- Static assets ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Sessions (persisted in Mongo) ----
app.use(
  session({
    name: 'hallel.sid',
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: env.mongoUri, dbName: env.dbName }),
    cookie: {
      httpOnly: true,
      secure: env.isProd,
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

app.use(flash());

// ---- Locals available to all views ----
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.baseUrl = env.baseUrl;
  next();
});

// ---- Routes ----
app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/payment', require('./routes/payment'));
app.use('/admin', require('./routes/admin'));

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found', status: 404 });
});

// ---- Error handler ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).render('error', {
    title: 'Something went wrong',
    message: env.isProd ? 'An unexpected error occurred.' : err.message,
    status,
  });
});

// ---- Boot ----
async function start() {
  await connectDB();
  await Settings.get();            // ensure the singleton settings doc exists
  await User.seedAdmin(env.admin); // seed initial admin if none
  app.listen(env.port, () => {
    console.log(`[app] Hallel AquaCare running on ${env.baseUrl}`);
  });
}

start().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});

module.exports = app;
