# Premium Gating for Co Captain (Popeye) — Route Sync + Baro Alert

## Context

The Garmin "Co Captain / Popeye" watch app currently offers two features for free that
are good candidates to monetize:

1. **Route sync to the watch** — pulling routes from the cloud onto the watch
   ([SyncHelper.mc](../Popeye/source/SyncHelper.mc)).
2. **The vibrating barometric alert** — an on-watch storm warning
   ([BaroMonitor.mc](../Popeye/source/BaroMonitor.mc)).

The goal is to lock these two **watch** features behind a one-time PayPal purchase while
keeping the web app's cloud-sync/account completely free (it's the backup + primary
experience). A signed-in user who is *not* premium sees, on the watch, a static QR code
that opens a new **premium registration page** on the web app; the user logs in there with
the same account and pays via PayPal, which flips `is_premium` to true. On the next watch
sync, the watch learns it's premium and unlocks both features.

**Confirmed decisions:** watch-only gating (web sync stays free) · one-time lifetime
purchase (boolean `is_premium`) · PayPal **sandbox** first, env-switchable to live · entry
button lives **inside the existing Cloud Sync panel**.

### Architecture recap (already in place)
- **Backend:** Vercel serverless (`.mjs`), Neon Postgres, JWT (jose) + bcrypt. Endpoints:
  `/api/auth/{register,login,me}`, `/api/sync`. DB helper [lib/db.mjs](lib/db.mjs),
  auth [lib/auth.mjs](lib/auth.mjs).
- **Watch knows nothing about premium today.** Login returns `{jwt,email}`; sync returns
  route data. We must surface `is_premium` through both and cache it in watch `Storage`.
- **The baro alert never calls the server** — so it can only be gated by the cached flag
  (client-side). Route sync *is* server-enforced.
- **Connect IQ has no QR generator** — the QR must be a pre-rendered static bitmap bundled
  as a drawable, encoding the fixed premium-page URL.

---

## Part A — Database

Add one column (run on Neon; document in [cloud-sync-plan.md](cloud-sync-plan.md)):

```sql
ALTER TABLE users ADD COLUMN is_premium BOOLEAN NOT NULL DEFAULT false;
```

Existing users default to non-premium. (Grandfather specific accounts later with a manual
`UPDATE` if desired.)

---

## Part B — Server (MarineNavApp)

### New: `lib/paypal.mjs`
Helper that reads env (`PAYPAL_ENV` = `sandbox`|`live`, `PAYPAL_CLIENT_ID`,
`PAYPAL_SECRET`, `PREMIUM_PRICE`, `PREMIUM_CURRENCY`), exposes:
- `PAYPAL_API_BASE` — `https://api-m.sandbox.paypal.com` vs `https://api-m.paypal.com`.
- `getAccessToken()` — OAuth2 client-credentials token.
- `createOrder()` / `captureOrder(orderId)` — PayPal Orders v2 calls (intent CAPTURE,
  amount from env). **Amount is set server-side** so the client can't tamper with price.

### New: `api/premium/config.mjs` (public GET)
Returns `{ clientId, price, currency, env }` so `premium.html` can build the PayPal SDK
script tag dynamically — flipping sandbox→live is a single Vercel env change, no code edit.

### New: `api/premium/create-order.mjs` (POST, JWT-authenticated)
Verifies the Bearer JWT via `authenticateRequest`, creates a PayPal order server-side,
returns `{ orderId }`.

### New: `api/premium/capture-order.mjs` (POST, JWT-authenticated)
Body `{ orderId }`. Captures the order server-side via `captureOrder`. **Only on a
`COMPLETED` capture** does it run `UPDATE users SET is_premium = true WHERE id = ${userId}`
and return `{ isPremium: true }`. Never trusts a client-side "I paid" claim.

### Edit: `api/auth/login.mjs`
Add `is_premium` to the existing `SELECT` ([login.mjs:22](api/auth/login.mjs#L22))
and return `{ jwt, email, isPremium }`.

### Edit: `api/auth/register.mjs`
Return `isPremium: false` in the success payload (new accounts are never premium).

### Edit: `api/auth/me.mjs`
`SELECT is_premium` by `userId`; include `isPremium` in the response.

### Edit: `api/sync.mjs`
Query the user's `is_premium` once. Then:
- **Watch client** (`isWatch`, [sync.mjs:24](api/sync.mjs#L24)):
  if **not** premium, skip the route pull and return
  `{ serverTime, premium: false, routes: {upserted:[],deleted:[]}, logs:{upserted:[],deleted:[]} }`.
  If premium, behave exactly as today plus `premium: true`. This **server-enforces** route
  sync gating for the watch.
- **Web client** (browser/Capacitor): unchanged behavior (free); include `premium: <bool>`
  in the response so the web UI can show the right badge. Client pushes still accepted.

### `vercel.json`
No change expected — `/api/(.*)` CORS already covers the new endpoints and `premium.html`
is served as a static file.

---

## Part C — Premium registration page (MarineNavApp)

### New: `premium.html` (repo root, standalone static page)
Reachable at `https://marine-nav-app.vercel.app/premium.html` — the QR target and the web
button target. Self-contained (own minimal styling; can mirror the app's dark palette).
Flow:
1. On load, `GET /api/premium/config` for the PayPal client-id/price; inject the PayPal JS
   SDK `<script src="https://www.paypal.com/sdk/js?client-id=...&currency=...">`.
2. **Feature blurb** — short description of the two unlocked features (watch route sync +
   vibrating baro storm alert).
3. **Sign-in form** (email + passphrase) → `POST /api/auth/login` (reuses existing
   endpoint). If `sync_jwt` already exists in `localStorage` (same origin as the app),
   reuse it. Store the returned `isPremium`.
4. If already premium → show "✓ Already unlocked — re-sync your watch" and skip checkout.
5. Otherwise render **PayPal Buttons**: `createOrder` → `POST /api/premium/create-order`;
   `onApprove` → `POST /api/premium/capture-order`. On success show a confirmation and
   instruct the user to open Co Captain and sync to unlock.

---

## Part D — Web app entry point (`index.html`)

- **Store premium status:** in the login/register/sync response handlers
  ([index.html:7141-7369](index.html#L7141-L7369)),
  persist `localStorage.sync_is_premium` from the response's `isPremium`/`premium`.
- **Sync panel button:** in the signed-in state of the Cloud Sync panel
  ([index.html:1324-1346](index.html#L1324-L1346)),
  add a **"Go Premium"** button (reusing the existing `.sync-btn` styling, so dark mode is
  automatic). When `sync_is_premium` is true, show a non-clickable "✓ Premium" badge
  instead. The button opens `premium.html` (via `window.open`; on Capacitor open in the
  external browser so PayPal works). Use `SYNC_API_BASE` to build the absolute URL.

---

## Part E — Garmin watch app (Popeye — `c:\Users\admin\Documents\Boaz\Devs\Popeye`)

### Edit: `source/SyncHelper.mc`
- In `onLoginResponse` ([SyncHelper.mc:82](../Popeye/source/SyncHelper.mc#L82)),
  cache `Storage.setValue("isPremium", data["isPremium"])`.
- In `onSyncResponse` ([SyncHelper.mc:122](../Popeye/source/SyncHelper.mc#L122)),
  cache `Storage.setValue("isPremium", data["premium"])` and only store routes when premium.
- Add `isPremium()` getter reading `Storage.getValue("isPremium")` (default `false` when
  unset/null).

### Edit: `source/RouteView.mc`
- Add a screen state between "no credentials" and "route list": **has credentials but not
  premium** ([RouteView.mc:43-53](../Popeye/source/RouteView.mc#L43-L53)).
- New `drawPremiumRequired(dc, ...)` draws short text ("Premium required — scan to unlock")
  plus the QR bitmap centered (`dc.drawBitmap`), loaded via `WatchUi.loadResource`. Reuse
  the `isSmall()` compact pattern already used by `drawNotLoggedIn`.

### New static QR asset
- `resources/drawables/premium_qr.png` — a pre-generated QR encoding
  `https://marine-nav-app.vercel.app/premium.html`. **Must be generated externally** (any
  QR generator) and added as a low-density PNG sized for the watch (e.g. ~120–140px square,
  high error-correction so it scans off a small screen). Register it in
  `resources/drawables/drawables.xml` as `PremiumQr`.

### Edit: `source/BaroMonitor.mc`
- Gate the alert on premium: in `onTick` ([BaroMonitor.mc:77](../Popeye/source/BaroMonitor.mc#L77))
  and/or `alertEnabled()` ([BaroMonitor.mc:237](../Popeye/source/BaroMonitor.mc#L237)),
  also require `Storage.getValue("isPremium") == true` before firing. The monitor starts at
  app launch reading the cached flag; it stays dormant until a premium sync sets the flag,
  after which it persists offline. (This is the only possible gate — baro never hits the
  server.)

---

## Verification (end-to-end)

1. **DB:** run the `ALTER TABLE` on Neon; confirm column exists.
2. **Backend:** set sandbox env vars in Vercel (`PAYPAL_ENV=sandbox`, sandbox client-id/
   secret, `PREMIUM_PRICE`, `PREMIUM_CURRENCY`). Test locally with `vercel dev` (or against
   a preview deploy):
   - `POST /api/auth/login` returns `isPremium:false` for a new account.
   - `POST /api/sync` with `client:"watch"` returns `premium:false` and empty routes for a
     non-premium user.
3. **Payment path:** open `premium.html`, sign in, complete a **PayPal sandbox** payment;
   confirm `capture-order` flips `is_premium=true` in Neon and the page shows confirmation.
   Re-login → `isPremium:true`; `/api/sync` (watch) now returns routes + `premium:true`.
4. **Web app:** signed-in Cloud Sync panel shows "Go Premium" before payment and the
   "✓ Premium" badge after; button opens `premium.html`.
5. **Watch (Connect IQ simulator):** build Popeye; set credentials; sync as non-premium →
   QR screen shows + no baro alert fires. Flip `is_premium=true` in DB, re-sync → routes
   appear and the baro alert is armed.
6. Before launch: swap Vercel env to live PayPal credentials (`PAYPAL_ENV=live`) — single
   config change, no code edits.

## Prerequisites / notes
- Requires a **PayPal sandbox app** (client-id + secret) from the PayPal Developer
  Dashboard; a live PayPal **business** account is needed before going live.
- The watch QR is a **static** image (just the page URL) — payment links to the account
  because the user signs in on `premium.html`, not via QR contents.
- Spans **two repos**: MarineNavApp (server + web + page) and Popeye (watch). The Popeye
  changes need a Connect IQ rebuild and re-publish to the Garmin store to reach users.
