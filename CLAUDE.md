# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Booking + admin system for **Hallel AquaCare**, a water-tank cleaning service. Clients self-book
online; the operator manages bookings, payments, and documents from an admin dashboard. Stack:
Express 5 + Mongoose + EJS/ejs-mate + Bootstrap 5 (vanilla client JS), MongoDB, Hubtel for
payments/SMS. Business context lives in `business_context/`; the full design lives in `plan.md`.

## Commands

```bash
npm run dev      # nodemon app.js (development)
npm start        # node app.js
```

- **No test suite exists** (`npm test` is a placeholder). Verify changes by driving the running app.
- Requires a local **MongoDB** on `127.0.0.1:27017` (Windows "MongoDB" service). DB name is
  `hallelAquaCareDB`, forced in `config/db.js` regardless of the URI's path.
- Copy `.env.example` → `.env`. On first boot with an empty `Users` collection, an admin is
  seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD`. Admin login: `/admin/login`.
- **Windows restart gotcha:** `pkill -f "node app.js"` does NOT kill the Node process here — the
  old code keeps serving :3000. Free the port first:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

## Architecture (big picture)

Layered Express app, no framework beyond Express. Flow: `app.js` (middleware + route mounting)
→ `routes/*` → `services/*` (business logic) → `models/*` (Mongoose). Views are server-rendered
EJS with an ejs-mate layout; interactivity is in `public/js/*` loaded per-page.

**Pricing is server-authoritative — this is the core invariant.** `services/pricing.js#computeQuote`
is the single source of truth for all money. It is called by BOTH `POST /api/quote` (live UI
preview) and `POST /booking` (persisted). The browser never computes totals; any amount sent by
the client is display-only and recomputed on submit. Do not duplicate pricing math into client JS.

**All tunable config lives in a single `Settings` document** (`models/Settings.js`, singleton via
`Settings.get()`), admin-editable at `/admin/settings`: base location, free radius, per-km transport
rate, min call-out fee, the full tank price matrix, distance provider, and the admin SMS number.
Change behavior by editing Settings, not by hardcoding. Defaults (incl. the price list from the
business plan) seed on first `Settings.get()`.

**Distance is pluggable** (`services/distance.js`): Haversine (free, default) or Google Distance
Matrix, selected by `Settings.distanceProvider`. Google falls back to Haversine on any error.

**Transport & pay-now rules** (in `computeQuote` + `routes/public.js`): free within `freeRadiusKm`;
otherwise `extraKm × ratePerKm`. Outside the radius, paying the transport fee online is a mandatory
commitment deposit (`payment.method='hubtel'`), with the balance collected on-site; within radius,
pay-now (full total) is optional.

**Data model:** `Booking` → collection `Bookings`. `Settings` and `User` also use explicit
collection names (`Settings`, `Users`) as the 3rd arg to `mongoose.model()`. `Counter` provides
atomic sequences for certificate/receipt numbers (`Counter.next('certificate')`).

**Auth:** `express-session` (persisted in Mongo via `connect-mongo`) + `bcryptjs`. `User.role`
(`superadmin`/`admin`/`staff`) exists for future multi-admin; `middleware/auth.js#requireAdmin`
guards `/admin/*`. There is currently no in-app password-change UI.

**Notifications** (`services/notifications.js`): Hubtel SMS to client + admin on new booking, wired
in `POST /booking` via `dispatchBookingNotifications` (fire-and-forget; failures logged, never block
or roll back the save). With SMS keys unset it logs a `[sms:dry-run]` line instead of sending.

**Documents** (`views/documents/*`, `services/documents.js`): certificate (mirrors
`business_context/hallel-aquacare-service-certificate.png`) and receipt are standalone print-styled
HTML pages (opened in a new tab → browser "Save as PDF"), with an embedded re-book QR. Rendered with
`layout: false` so they don't inherit the app chrome.

**Payments (Hubtel) are a stubbed seam** — `routes/payment.js` and `services/hubtel.js` have
`TODO(hubtel)` markers awaiting official docs. The cash / pay-on-site / pay-later path is fully
functional without Hubtel; manual payment confirmation is in `PATCH /admin/bookings/:id/payment`.

## Gotchas

- **Never pass a render local named `settings`.** Express exposes its own `settings` (containing
  `.views`) via `app.locals`; a same-named local shadows it and breaks ejs-mate layout resolution
  with a cryptic `path.join received undefined`. The `Settings` doc is passed to views as `cfg`.
- `connect-mongo` v6 is a default export: `require('connect-mongo').default`.
- Top-level `ejs` is v6 but ejs-mate renders via its own bundled `ejs@3.1.10`; templates follow
  EJS 3 semantics.
- Forms that need PUT/DELETE use `method-override` via `?_method=DELETE` on a POST action.
- helmet CSP in `app.js` allowlists the CDNs (jsdelivr/unpkg) and OSM/Nominatim; adding a new
  external asset host requires updating that CSP.

## Future provisions (schema only, not built)

`Booking.addOns[]` (store page) is already summed by `computeQuote`; `Booking.plan` +
`Settings.quarterlyDiscountPct` anticipate recurring/quarterly billing.
