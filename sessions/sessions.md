# Hallel AquaCare — Session Handoff

_Last updated: 2026-07-28. Read this first when resuming. Companion docs: `plan.md` (full
design), `CLAUDE.md` (architecture cheat-sheet), `business_context/` (business plan + certificate
image)._

---

## 1. What this project is

An end-to-end booking + admin system for **Hallel AquaCare**, a no-entry water-tank cleaning &
disinfection service (subsidiary of Hallel Industries Ltd). Three surfaces:

1. **Public booking form** — clients self-book online.
2. **MongoDB storage** — bookings safely persisted.
3. **Admin dashboard** — operator views/manages bookings, payments, documents.

**Stack:** HTML + Bootstrap 5 + vanilla JS (frontend); Express 5 + Mongoose + EJS + ejs-mate
(backend); MongoDB; Hubtel for payments + SMS. CommonJS, Node.

---

## 2. Current status

| Area | Status |
|---|---|
| Project scaffold, config, DB connect | ✅ Done |
| Models (Booking, Settings, User, Counter) | ✅ Done |
| Distance + pricing services | ✅ Done |
| Public booking form + live quote + submit | ✅ Done, verified E2E |
| SMS notifications (client + admin) | ✅ Done (dry-run until Hubtel keys) |
| Auth + admin dashboard + actions | ✅ Done, verified |
| Admin settings page (all metrics editable) | ✅ Done, verified |
| Certificate + receipt documents | ✅ Done, verified |
| Hardening (validation, rate-limit, helmet, 404/errors) | ✅ Done |
| **Hubtel live payments** | ⏳ **Stubbed — awaiting Hubtel docs from user** |
| In-app admin password change / manage staff | ❌ Not built (user asked about it) |

Everything except live Hubtel payment works today. Cash / pay-later / manual-confirm is fully
functional. Every flow was verified via curl against the running app.

---

## 3. How to run

```bash
npm run dev      # nodemon (dev)
npm start        # node app.js
```

- **MongoDB** must be running locally: Windows "MongoDB" service on `127.0.0.1:27017`. DB name
  `hallelAquaCareDB` (forced in `config/db.js`).
- Env: `.env` already exists (dev values); template in `.env.example`.
- **Admin login:** `http://localhost:3000/admin/login` → username `admin`, password `admin123`
  (from `.env`, seeded on first boot when the `Users` collection was empty).
- **Windows restart gotcha:** `pkill` does NOT kill the Node process here. Free the port with:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`

---

## 4. File map

```
app.js                     # express app: middleware, helmet CSP, sessions, routes, boot+seed
config/env.js              # typed env access (dotenv)
config/db.js               # mongoose connect -> hallelAquaCareDB
models/
  Booking.js               # -> collection 'Bookings'
  Settings.js              # singleton config doc (Settings.get()); seeds price list from plan
  User.js                  # admin users, role field, seedAdmin(), bcryptjs
  Counter.js               # atomic sequences (cert/receipt numbers)
services/
  distance.js              # getDistanceKm(): haversine | google (pluggable)
  pricing.js               # computeQuote() -- SINGLE SOURCE OF TRUTH for money
  notifications.js         # Hubtel SMS: client confirmation + admin ping (fire-and-forget)
  hubtel.js                # payment seam (TODO markers, awaiting docs)  [in routes/payment.js]
  documents.js             # cert/receipt numbering + re-book QR
middleware/
  auth.js                  # requireAdmin, requireRole
  validators.js            # express-validator chains
routes/
  public.js                # GET /, POST /api/quote, POST /booking, GET /booking/success/:id
  auth.js                  # GET/POST /admin/login, DELETE /admin/logout
  admin.js                 # dashboard, detail, payment/job PATCH, cert/receipt, settings
  payment.js               # /payment/callback, /payment/webhook, /payment/status/:id  (stub)
views/
  layouts/boilerplate.ejs  # ejs-mate layout (Bootstrap 5 + Leaflet)
  partials/{navbar,flash}.ejs
  public/{booking,success}.ejs
  admin/{login,dashboard,booking-detail,settings}.ejs
  documents/{certificate,receipt}.ejs   # standalone print HTML
  error.ejs
public/
  css/app.css
  js/booking.js            # map, tank rows, debounced quote, conditional pay-now
  js/admin.js              # card modal expand, AJAX actions
plan.md, CLAUDE.md, .env, .env.example, .gitignore
```

---

## 5. Key decisions (locked with user)

- **Distance:** Leaflet + OSM map picker + Haversine (straight-line) now, behind a pluggable
  provider so switching to Google Distance Matrix (driving distance) is a Settings change.
- **Pay amount:** within radius → paying full total now is optional; outside radius → transport
  fee only is a mandatory commitment deposit, balance collected on-site.
- **Settings:** ALL adjustable metrics are DB-backed and editable at `/admin/settings`.
- **Auth:** session + bcrypt, single seeded admin now, `Users` collection + `role` for easy
  multi-admin later.
- **Notifications:** SMS via Hubtel SMS (same vendor as payments). WhatsApp automation deferred
  (needs Meta template approval); a `wa.me` link is on the success page as a fallback.

---

## 6. Core business logic

**Pricing (`services/pricing.js#computeQuote`) — server-authoritative.** Called by both
`POST /api/quote` (live UI) and `POST /booking` (persisted). Browser values are display-only.
Steps: sum `unitPrice(size,tier) × qty` → apply min call-out floor → compute distance →
`extraKm = max(0, distanceKm − freeRadiusKm)` → `transportFee = extraKm × ratePerKm` →
`total = jobSubtotal + transportFee`. `payNowRequired = transportFee > 0`.

**All config comes from the `Settings` singleton:** base location (lat/lng/name), `freeRadiusKm`
(17), `transportRatePerKm` (6), `minCallOutFee` (150), `distanceProvider`, `priceList` (10 tank
sizes, standard + preserve prices, seeded from the business plan), `adminNotifyNumber`,
`notificationsEnabled`, `businessInfo` (for docs/SMS), `quarterlyDiscountPct` (future).

---

## 7. Routes reference

Public: `GET /` (form), `POST /api/quote` (JSON price, saves nothing), `POST /booking` (validate →
recompute → persist → notify → success/pay), `GET /booking/success/:id`.
Auth: `GET/POST /admin/login`, `DELETE /admin/logout` (via `?_method=DELETE`).
Admin (`requireAdmin`): `GET /admin` (cards+stats+filters), `GET /admin/bookings/:id` (modal
fragment), `PATCH .../payment` (manual cash: full|deposit), `PATCH .../job` (toggle),
`PATCH .../certificate` (save residual/next-due/technician), `GET .../certificate` & `.../receipt`
(print pages), `GET/POST /admin/settings`.
Payment (stub): `/payment/callback`, `/payment/webhook`, `/payment/status/:id`.

---

## 8. Data model (Booking → `Bookings`)

Client (name, whatsapp, email), `serviceTier` (standard|preserve), `tanks[]` (sizeKey, label,
capacityLitres, quantity, unitPrice, lineTotal), `bookingDate`, `location` (address, lat, lng,
distanceKm), `transport` (free, extraKm, ratePerKm, fee), `pricing` (tanksSubtotal,
minCalloutApplied, transportFee, total), `payment` (method [hubtel|cash|none], payNowChoice,
status [unpaid|deposit_paid|paid], amountPaid, amountDue, hubtel{...}, confirmedManually/By/At),
`jobStatus` + `jobCompleted`, `certificate` (number, freeChlorineResidual, nextServiceDue,
technician, issuedAt), `receiptNumber`. Future: `addOns[]` (summed by pricing), `plan` (recurring).

---

## 9. Gotchas (already hit + solved — don't repeat)

1. **Never pass a render local named `settings`** — it shadows Express's `app.locals.settings`
   (which holds `.views`) and breaks ejs-mate layouts with `path.join received undefined`. The
   Settings doc is passed to views as **`cfg`**.
2. `connect-mongo` v6 → `require('connect-mongo').default`.
3. Top-level `ejs` is v6 but ejs-mate renders via its bundled `ejs@3.1.10` (EJS 3 semantics).
4. `npm audit` shows 6 highs — all transitive `brace-expansion` via build tooling / nodemon (not
   runtime-reachable). The "fix" force-downgrades ejs-mate; left as-is intentionally.
5. Windows `pkill` doesn't kill Node — use the port-based Stop-Process command (section 3).

---

## 10. Test data state

There are **test bookings** in `hallelAquaCareDB.Bookings` from verification runs (e.g. "Ama Test",
"Kofi Far"). They are safe to delete anytime. To wipe just bookings (keeps Settings + admin):

```js
// node -e with require('D:/Projects/TownTack/Hallel_AC/node_modules/mongoose')
await mongoose.connection.collection('Bookings').deleteMany({});
```

Settings note: base location lat/lng are **placeholder** (~Accra). Set real Emefs Hillview
coordinates in `/admin/settings` before relying on transport-fee accuracy. During testing the
per-km rate and one price were changed then restored to plan defaults; `adminNotifyNumber` was set
to `233530551604`.

---

## 11. Open items / recommended next steps

1. **Hubtel integration** — user is providing docs. Wire `services/hubtel.js` createCheckout,
   `POST /payment/webhook` (verify signature → update `payment.status`), `GET /payment/callback`,
   and live SMS keys in `.env`. Look for `TODO(hubtel)` markers.
2. **Admin account management** — no in-app password change yet. Add `/admin/settings` → Account
   ("change my password"), and optionally "add staff login" (schema + `requireRole` already support it).
3. **Set real base coordinates** in Settings.
4. **Clear test bookings** when ready to go live (section 10).
5. **Future features (schema already provisioned):** store/add-ons page (`Booking.addOns[]`),
   recurring quarterly plan (`Booking.plan` + `Settings.quarterlyDiscountPct`), multi-admin/locations.

---

## 12. Task tracker state (from this session)

Tasks #1–#9 and #11 completed. **#10 (Hubtel payment integration) pending** — blocked on user
providing Hubtel documentation.
