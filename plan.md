# Hallel AquaCare — Booking & Admin System

## Context

Hallel AquaCare (a subsidiary of Hallel Industries Ltd) is a no-entry water-tank
cleaning & disinfection service (see `business_context/water-tank-cleaning-business-plan.md`).
Today, bookings would be taken by phone/WhatsApp. We are building an **end-to-end web
system** so clients can self-book online, the data is safely stored, and the operator
manages everything from an admin dashboard.

The system must:
1. Serve a styled **booking form** (contact details, service tier, tanks + quantities,
   map location picker, live transport-fee + total, pay-now choice).
2. Compute **transport fees** by distance from the base (Emefs Hillview Palace Estate):
   free within a configurable radius (17 km), else a configurable rate (6 GHS) per extra km.
3. Store bookings in MongoDB (`hallelAquaCareDB`, collection `Bookings`).
4. Provide an authenticated **admin dashboard** with expandable booking cards, payment
   status (Hubtel + manual/cash), receipt & certificate generation, and a job-complete toggle.
5. On every new booking, send an **SMS confirmation to the client** and an **SMS ping to the
   admin** so the operator knows immediately a booking was placed.

The stack is deliberately the operator's familiar one for easy debugging:
**HTML + Bootstrap 5 + vanilla JS** (frontend); **Express + Mongoose + EJS + ejs-mate**
(backend); **MongoDB**; **Hubtel** for payments.

### Decisions locked with the user
- **Distance:** Leaflet + OpenStreetMap picker + Haversine straight-line now, behind a
  pluggable provider so Google Distance Matrix (driving distance) is a future config swap.
- **Pay amount:** within radius → full-total pay-now is optional; outside radius → transport
  fee only is a mandatory commitment deposit, balance collected on-site.
- **Settings:** all adjustable metrics (base location, radius, per-km rate, min call-out,
  full tank price matrix) are DB-backed and admin-editable.
- **Auth:** session + bcrypt, single seeded admin now, on a `Users` collection with a `role`
  field for easy multi-admin later.
- **Notifications:** SMS via **Hubtel SMS API** (same vendor as payments — one account) for
  both the client confirmation and the admin ping. Built behind a `notifications` service so a
  WhatsApp Cloud API channel can be added later. A `wa.me` click-to-chat link on the success
  page is a zero-config fallback. Admin notify number is editable in Settings.

### Current state
Greenfield. Only `express`, `ejs`, `mongoose` installed; no app code, models, views, or
routes exist. `package.json` uses CommonJS. Git has a single initial commit.

---

## Gaps found in the brief & how they're filled

| Gap / loophole | Resolution | Why |
|---|---|---|
| Distance-to-base calculation was unspecified | Server-side pluggable `distance` service (Haversine now, Google later); Leaflet map picker on frontend | Fees must be trustworthy; free now, upgradeable |
| Client could tamper with the fee/total in the browser | **All pricing recomputed server-side** on submit from DB settings + pinned coordinates; the browser value is display-only | Never trust client-sent money values |
| Admin dashboard had no access control | `express-session` + `bcryptjs` login, `requireAdmin` middleware on `/admin/*` | It exposes customer PII and payment controls |
| Prices/base location "adjustable" but no storage defined | Singleton `Settings` document + admin Settings page | Operator edits without touching code |
| Certificate No. / receipt numbering | Atomic `Counter` collection → `HAC-2026-0001` style refs | Sequential, collision-free, audit-friendly |
| PDF generation method unspecified | Certificate & receipt as print-styled EJS pages opened in a new tab (browser "Save as PDF"); puppeteer noted as optional upgrade for server-side/email attachments | Zero heavy deps, pixel-matches the certificate PNG, reliable on Windows |
| "Scan to re-book" QR on certificate | `qrcode` lib → data-URI QR pointing at the booking URL | Matches the certificate template |
| Min call-out fee (GHS 150) from the plan | Applied as a floor in the pricing service | Protects small-tank economics per the plan |
| Booking-date capacity/availability | Store the requested date now; **capacity limits deferred** (noted as future) | Not in scope; avoid over-building |
| Hubtel docs not yet provided | Payment behind a `hubtel` service with a clear integration seam; the **cash/manual + pay-later flow is fully functional without Hubtel** | System is usable day one; wire Hubtel when docs arrive |
| Input validation / abuse | `express-validator` on booking/settings/login; `express-rate-limit` on booking + login; `helmet` headers | Basic security hygiene |
| Future recurring plan & store page | Schema provisions only (see Future-proofing) — not built | Build now would be speculative; provisions keep it cheap later |
| Client/admin unaware a booking was placed | `notifications` service sends SMS confirmation to client + SMS ping to admin (Hubtel SMS); `wa.me` fallback link on success page; failures logged, never block the booking save | Operator must react fast; SMS is the most reliable channel in Ghana without WhatsApp template approval |

---

## Architecture & file layout

```
Hallel_AC/
  app.js                     # express app, ejs-mate, middleware, route mounting
  .env.example               # documented; real .env gitignored
  .gitignore                 # node_modules, .env
  config/
    db.js                    # mongoose connect -> hallelAquaCareDB
    env.js                   # typed env access + defaults
  models/
    Booking.js               # model('Booking', schema, 'Bookings')
    Settings.js              # singleton config doc + getSettings() helper
    User.js                  # admin users, role field
    Counter.js               # atomic sequences (cert/receipt numbers)
  services/
    distance.js              # getDistanceKm(base,dest): haversine | google (pluggable)
    pricing.js               # computeQuote(tanks, tier, latlng, settings) -> breakdown
    hubtel.js                # createCheckout / verify / webhook parse (integration seam)
    notifications.js         # sendBookingConfirmation(client) + notifyAdmin() via Hubtel SMS
    documents.js             # cert/receipt view-model builders + QR + numbering
  middleware/
    auth.js                  # requireAdmin, requireRole
    validators.js            # express-validator chains
  routes/
    public.js                # GET /, POST /api/quote, POST /booking, GET /booking/success/:id
    auth.js                  # GET/POST /admin/login, POST /admin/logout
    admin.js                 # dashboard, detail, payment-confirm, job-toggle, cert/receipt, settings
    payment.js               # /payment/callback, /payment/webhook, /payment/status/:id
  views/
    layouts/boilerplate.ejs  # ejs-mate layout (Bootstrap 5)
    partials/                # navbar, flash, head
    public/booking.ejs
    public/success.ejs
    admin/login.ejs
    admin/dashboard.ejs      # booking cards
    admin/booking-detail.ejs # expanded card content (also served as fragment for modal)
    admin/settings.ejs
    documents/certificate.ejs
    documents/receipt.ejs
  public/
    css/booking.css, admin.css, print.css
    js/booking.js            # map, tank rows, debounced quote, conditional pay-now
    js/admin.js              # card expand, AJAX actions
    images/logo.svg
```

### New dependencies
`ejs-mate`, `dotenv`, `express-session`, `connect-mongo`, `bcryptjs` (pure-JS, avoids
Windows native-build pain), `express-validator`, `express-rate-limit`, `helmet`,
`method-override`, `connect-flash`, `axios` (Hubtel payment + SMS calls), `qrcode`, `nodemon` (dev).
Leaflet + Bootstrap loaded on the frontend (self-host or CDN-allowlisted in helmet CSP).

---

## Data models

**Booking** (`models/Booking.js`, collection `Bookings`)
- `clientName` (req), `whatsapp` (req, validated), `email` (optional)
- `serviceTier`: enum `['standard','preserve']`
- `tanks`: `[{ sizeKey, label, capacityLitres, quantity, unitPrice, lineTotal }]`
- `bookingDate` (Date, req) — requested service date
- `location`: `{ address, lat, lng, distanceKm }`
- `transport`: `{ free: Bool, extraKm, ratePerKm, fee }`
- `pricing`: `{ tanksSubtotal, minCalloutApplied: Bool, transportFee, total }`
- `payment`: `{ method: ['hubtel','cash','none'], payNowChoice: ['now','later'],
   status: ['unpaid','deposit_paid','paid'], amountPaid, amountDue,
   hubtel: { reference, transactionId, checkoutUrl, raw }, confirmedManually: Bool,
   confirmedBy, confirmedAt }`
- `jobStatus`: enum `['pending','scheduled','completed']`; `jobCompleted` derived toggle
- `certificate`: `{ number, freeChlorineResidual, nextServiceDue, technician, issuedAt }`
- `receiptNumber`
- `addOns`: `[{ sku, name, qty, unitPrice, lineTotal }]`  *(future store; empty for now)*
- `plan`: `{ recurring: Bool, interval }`  *(future quarterly; default one-off)*
- timestamps

**Settings** (singleton) — `baseLocation {name,lat,lng}`, `freeRadiusKm` (17),
`transportRatePerKm` (6), `minCallOutFee` (150), `distanceProvider` (`haversine`),
`priceList: [{ sizeKey, label, capacityLitres, standardPrice, preservePrice, custom }]`
(seeded from the plan's price table), `quarterlyDiscountPct` (15, future),
`adminNotifyNumber` (SMS ping destination), `notificationsEnabled` (Bool),
`businessInfo {name, phone, subsidiaryOf, address}` (for cert/receipt & SMS sender).
`getSettings()` lazily creates the default doc.

**User** — `name`, `username`, `passwordHash`, `role: ['superadmin','admin','staff']`
(default `admin`). Seeded on startup from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env if none exists.

**Counter** — `{ _id, seq }` incremented atomically via `findOneAndUpdate($inc)` for cert/receipt numbers.

---

## Core logic

**`services/distance.js`**
```
haversine(a,b) -> straight-line km
getDistanceKm(base, dest, settings):
  settings.distanceProvider === 'google' ? googleDistance(...) : haversine(base,dest)
```
Frontend Leaflet picker + Nominatim address search sends `{lat,lng,address}`. The server
is the source of truth for distance and fee.

**`services/pricing.js`** — `computeQuote(tanks, tier, latlng, settings)`:
1. `tanksSubtotal = Σ unitPrice(size,tier) × qty`
2. `jobSubtotal = max(tanksSubtotal, minCallOutFee)` (flag if floor applied)
3. `distanceKm = getDistanceKm(...)`; `extraKm = max(0, distanceKm - freeRadiusKm)`
4. `transportFee = round(extraKm × transportRatePerKm)`; `free = transportFee === 0`
5. `total = jobSubtotal + transportFee`
6. `payNowRequired = !free`; `mandatoryAmount = free ? 0 : transportFee`
Returns full breakdown. Used by both `POST /api/quote` (live UI) and `POST /booking`
(authoritative) — single implementation, no duplicated JS math.

**`services/notifications.js`** — thin channel abstraction:
- `sendBookingConfirmation(booking)` → SMS to `booking.whatsapp` (date, tanks, total, ref).
- `notifyAdmin(booking)` → SMS to `settings.adminNotifyNumber` ("New booking: name, date, total").
- Current channel = Hubtel SMS (via `axios`, keys in env); a `whatsapp` channel can be added later
  without touching callers. All sends are **fire-and-forget with try/catch + logging** — a failed
  SMS must never roll back or block the saved booking. Skipped when `notificationsEnabled` is false.

**Pay-now rules (enforced server-side):**
- Free transport + `payNowChoice=now` → Hubtel checkout for **full total**.
- Free transport + `payNowChoice=later` → save, `status=unpaid`, pay on-site.
- Outside radius → Hubtel checkout for **transport fee** (mandatory deposit);
  `status=deposit_paid` on success; balance `amountDue = total − transportFee` collected on-site.
  Client may still opt to pay full total (small "pay full amount" toggle).

---

## Request flow

**Public**
- `GET /` → booking form seeded with settings (price list, base location for the map).
- `POST /api/quote` → validate + `computeQuote` → JSON breakdown (debounced live updates).
- `POST /booking` → validate → **recompute** quote server-side → persist Booking →
  **`notifications.sendBookingConfirmation` + `notifications.notifyAdmin`** (fire-and-forget) →
  if pay-now needed, `hubtel.createCheckout` and redirect; else `success`.
- `GET /booking/success/:id` → confirmation + `wa.me` click-to-chat link.

**Payment**
- `GET /payment/callback` (Hubtel return) → look up by reference → mark paid/deposit → success page.
- `POST /payment/webhook` → verify signature (per Hubtel docs) → authoritative status update.
- `GET /payment/status/:id` → optional polling.

**Auth** — `GET/POST /admin/login`, `POST /admin/logout`.

**Admin** (`requireAdmin`)
- `GET /admin` → cards (filters: date, jobStatus, paid/unpaid).
- `GET /admin/bookings/:id` → detail (page + fragment for expand).
- `PATCH /admin/bookings/:id/payment` → manual cash confirm (green status).
- `PATCH /admin/bookings/:id/job` → toggle job completed.
- `PATCH /admin/bookings/:id/certificate` → save chlorine residual / next-due / technician.
- `GET /admin/bookings/:id/certificate` & `/receipt` → print-styled EJS docs.
- `GET/POST /admin/settings` → edit all adjustable metrics.

---

## Routes explained (plain English, for a first full-stack build)

A "route" = a URL + an HTTP verb the server listens for. The verb signals intent:
**GET** = give me a page/data (saves nothing); **POST** = here's new data, create/process it;
**PATCH** = update part of an existing record. Data-only routes use an `/api/` prefix by convention.

- **`GET /`** — loads the booking form page in the browser.
- **`POST /api/quote`** — the **live price calculator**. As the client changes tanks or drops a
  map pin, the page's JavaScript sends those choices here *in the background* (no reload); the
  server calculates transport fee + total and returns JSON, and the page updates the price.
  **It saves nothing** — just "what would this cost?". Math lives on the server so the price is
  tamper-proof and there is a single copy of the pricing logic.
- **`POST /booking`** — fires on **Book Now**; *actually saves* the booking (after re-checking the
  price server-side), sends the SMS notifications, then redirects to Hubtel or the success page.
- **`GET /booking/success/:id`** — the thank-you page; `:id` is that booking's unique id in the URL.
- **`GET/POST /admin/login`** — GET shows the form; POST checks the password and starts the session.
- **`GET /admin`** — the dashboard of booking cards (only when logged in).
- **`PATCH /admin/bookings/:id/payment`** — "Confirm Cash Payment": updates just that booking.
- **`PATCH /admin/bookings/:id/job`** — the "Job Completed" toggle.
- **`POST /payment/webhook`** — Hubtel's *server* calls this URL directly (not the browser) to
  confirm a payment succeeded — the reliable source of truth for payment status.

---

## Frontend

**Booking form (Bootstrap 5, `public/js/booking.js`):** contact section; tier toggle
(Standard vs Clean-and-Preserve); **dynamic tank rows** (size dropdown + qty, add/remove);
Leaflet map with address search + "use my location"; live transport-fee + itemized total
via `/api/quote` (debounced); conditional pay-now dropdown (forced with an explanatory note
when outside radius); client-side validation before submit. Book Now button.

**Admin (`public/js/admin.js`):** dashboard of clickable cards; click expands to detail with
payment status badge (green = paid/Hubtel), Confirm Cash Payment, Generate Receipt, Generate
Certificate, and Job Completed toggle — actions via `fetch` PATCH + `method-override`.

**Documents:** `certificate.ejs` mirrors `business_context/hallel-aquacare-service-certificate.png`
(header, water-drop logo, title, cert no., client/date/address/residual/tank/next-due fields,
standard/preserve checkboxes, QR "scan to re-book", signature line, subsidiary footer).
`receipt.ejs` = itemized tanks + transport + total + amount paid + balance + method. Both use
`public/css/print.css` (`@media print`, landscape) so the browser's Save-as-PDF is clean.

---

## Security & hardening
- Server-side price recomputation (client money values are display-only).
- `express-validator` on booking/settings/login; `express-rate-limit` on booking + login.
- `helmet` (CSP allowlisting Leaflet/Bootstrap/Nominatim); session cookie `httpOnly`,
  `secure` in prod, secret from env; sessions persisted in Mongo via `connect-mongo`.
- Hubtel webhook signature verification (per docs when supplied); store raw payloads.
- `.env` gitignored; secrets: `MONGODB_URI`, `SESSION_SECRET`, `ADMIN_USERNAME/PASSWORD`,
  `HUBTEL_*` (payment + SMS keys, sender id), `BASE_URL`.

## Future-proofing (provisions only — not built now)
- **Recurring/quarterly:** `plan.recurring/interval` on Booking; `quarterlyDiscountPct` in
  Settings; payment service isolated so Hubtel recurring/direct-debit slots in.
- **Store page:** `addOns[]` already summed in pricing; a `Product` model + store route drop in later.
- **Multi-admin/locations:** `User.role` + `requireRole` skeleton; base location currently
  single, with a note that a `Locations` collection generalizes it.

---

## Build order (incremental, each stage runnable)
0. Create **`plan.md` at the repo root** (a copy of this plan) so it lives with the project.
1. Scaffold: deps, `.env.example`, `.gitignore`, `config/`, ejs-mate layout, DB connect.
2. Models + seeds: `Settings` (price list from plan), `User` (admin), `Booking`, `Counter`.
3. Services: `distance`, `pricing`.
4. Public booking form + `/api/quote` + `POST /booking` — **cash/pay-later E2E working** (no Hubtel yet).
5. `notifications` service: SMS confirmation to client + ping to admin on new booking; `wa.me` link on success.
6. Auth + admin dashboard (cards, detail, manual payment confirm, job toggle).
7. Admin settings page (edits all metrics incl. admin notify number; re-quote reflects changes).
8. Certificate + receipt (EJS + print CSS + QR + Counter numbering).
9. Hubtel integration (on docs): payment `createCheckout`, callback, webhook, signature verify; wire live SMS keys.
10. Hardening: validators, rate-limit, helmet, error pages, 404.

---

## Verification (end-to-end)
1. `npm install` new deps; copy `.env.example` → `.env` (local Mongo or Atlas URI, session
   secret, admin creds). Start Mongo. `npm run dev`.
2. **Within radius:** book (pin near base) → transport shows **Free**, pay-later → success →
   appears in `/admin`. Confirm `hallelAquaCareDB.Bookings` doc has correct server-computed totals.
   Confirm the **client confirmation SMS** and **admin ping SMS** are attempted (logged/sent);
   with keys unset, verify the booking still saves and the failure is logged (never blocks).
3. **Outside radius:** pin >17 km → transport fee appears, pay-now forced for the deposit →
   (Hubtel stub / or manual) → `status=deposit_paid`, `amountDue` = balance.
4. **Admin:** log in, expand card, Confirm Cash Payment → badge green; toggle Job Completed;
   fill residual/next-due → Generate Certificate (matches PNG) and Generate Receipt (print preview).
5. **Settings:** change per-km rate / a tank price / base location → re-run a quote → fee & total
   update accordingly (proves DB-driven config).
6. Run the `verify` skill on the booking + admin flows before committing.
