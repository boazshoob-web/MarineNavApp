# Cloud Sync Implementation Plan

## Context
The app is local-only today. The goal is to let users plan routes on desktop and use them on mobile (including offline). We'll add magic-link auth, a Neon Postgres database, and Vercel API routes so routes and logs sync across all devices. No paywall — free membership for sync.

## What the user needs to prepare before coding

### Neon
1. Create a project (region: `aws-eu-central-1` Frankfurt — closest to Israel)
2. Run the schema SQL (provided below) in the Neon SQL editor
3. Copy the `DATABASE_URL` connection string

### Resend (email service for magic links)
1. Create account at resend.com
2. Add a custom domain or use `onboarding@resend.dev` for testing (only sends to your own email)
3. Create an API key → `RESEND_API_KEY`

### Vercel
1. Link the GitHub repo
2. Framework preset: **Other** (not Next.js)
3. Root directory: project root
4. No build command (static files + `/api` auto-detected)
5. Set environment variables:
   - `DATABASE_URL` — Neon connection string
   - `JWT_SECRET` — generate with `openssl rand -hex 32`
   - `RESEND_API_KEY` — from Resend
   - `RESEND_FROM_EMAIL` — e.g. `noreply@yourdomain.com`

---

## Neon DB Schema

```sql
CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE magic_links (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL,
    code       TEXT NOT NULL,          -- 6-digit code
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN DEFAULT false
);
CREATE INDEX idx_magic_links_email ON magic_links(email);

CREATE TABLE routes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    route_timestamp BIGINT NOT NULL,
    waypoints       JSONB NOT NULL,
    params          JSONB,
    depth_profiles  JSONB,
    weather         JSONB,
    bounds          JSONB,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    deleted         BOOLEAN DEFAULT false,
    UNIQUE(user_id, local_id)
);
CREATE INDEX idx_routes_user_updated ON routes(user_id, updated_at);

CREATE TABLE logs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_id             TEXT NOT NULL,
    captain_name         TEXT,
    departure_location   TEXT,
    departure_datetime   TIMESTAMPTZ,
    destination_location TEXT,
    arrival_datetime     TIMESTAMPTZ,
    closed               BOOLEAN DEFAULT false,
    entries              JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at           TIMESTAMPTZ DEFAULT now(),
    updated_at           TIMESTAMPTZ DEFAULT now(),
    deleted              BOOLEAN DEFAULT false,
    UNIQUE(user_id, local_id)
);
CREATE INDEX idx_logs_user_updated ON logs(user_id, updated_at);
```

**Note:** No sessions table needed — using stateless JWTs. Device-specific fields (`hasTiles`, `tileBytes`, `tileUrls`) are NOT stored in the cloud.

---

## Implementation Phases

### Phase 1: Vercel deployment + static hosting
- Add `vercel.json` with CORS headers for API routes (needed by Capacitor/PWA origins)
- Add `@neondatabase/serverless`, `jose`, `resend` to `package.json`
- Deploy, verify `index.html` loads from Vercel

### Phase 2: API routes
New files under `api/`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/send-code` | POST | Send 6-digit magic code via Resend |
| `/api/auth/verify` | POST | Verify code, return JWT |
| `/api/auth/me` | GET | Return current user info from JWT |
| `/api/sync` | POST | Bidirectional sync (push + pull) |

**`lib/db.js`** — Neon connection helper
**`lib/auth.js`** — JWT verification helper (using `jose`)

#### Auth flow (6-digit code — works on web, Android APK, and iOS PWA alike)
1. User enters email → app calls `POST /api/auth/send-code`
2. Server upserts user, generates 6-digit code, emails it via Resend (15-min expiry)
3. User enters code in app → app calls `POST /api/auth/verify {email, code}`
4. Server validates, returns `{jwt}` (30-day expiry, signed with `JWT_SECRET`)
5. App stores JWT in `localStorage('sync_jwt')`

#### Sync protocol (`POST /api/sync`)
Request: `{lastSync, routes: {upserted, deleted}, logs: {upserted, deleted}}`
Response: `{serverTime, routes: {upserted, deleted}, logs: {upserted, deleted}}`

Server logic:
1. Process client pushes: `INSERT ... ON CONFLICT(user_id, local_id) DO UPDATE ... WHERE updated_at < EXCLUDED.updated_at` (last-write-wins)
2. Process client deletes: soft-delete (set `deleted=true`)
3. Pull server changes: `SELECT ... WHERE user_id=$1 AND updated_at > $lastSync`
4. Return merged results + `serverTime`

### Phase 3: Client auth UI (`index.html`)
- New "Cloud Sync" button in floating menu (cloud icon)
- New sync panel with two states:
  - **Signed out:** email input → send code → code input → verify
  - **Signed in:** shows email, last sync time, "Sync Now" button, "Sign Out"
- New localStorage keys: `sync_jwt`, `sync_last_ts`, `sync_deleted`, `sync_user_email`

### Phase 4: Client sync engine (`index.html`)
- Add `updatedAt` field to route/log records on every save
- New functions: `syncCloud()`, `trySyncCloud()`, `mergeServerRoute()`, `addPendingDelete()`
- Wire into existing functions:
  - `saveRouteLight()` / `saveRouteOffline()` → add `updatedAt`, call `trySyncCloud()` after save
  - `saveLogEntry()` / `closeActiveLog()` → add `updatedAt`, call `trySyncCloud()` after save
  - `executeRouteDelete()` / log delete → track deletion, call `trySyncCloud()`
  - App init → call `trySyncCloud()` on startup
- `mergeServerRoute()` preserves local-only fields (`hasTiles`, `tileBytes`, `tileUrls`) when applying server data
- API base URL: `window.Capacitor ? 'https://marinanav.vercel.app' : ''`

### Phase 5: Service worker update (`sw.js`)
- Add Vercel domain to `API_ORIGINS` so sync requests bypass cache (network-first)

### Phase 6: Capacitor rebuild
- `npm run sync` + build APK
- Verify sync works from the Android app

---

## Migration (existing local data → cloud)
- On first sign-in, `lastSync` is null → all local routes/logs are pushed to server
- Records without `updatedAt` fall back to their `timestamp` field
- On a second device, first sync pulls everything from server into empty IndexedDB
- Routes arrive without tiles — user can tap "Add Offline Maps" per route on the new device

## Conflict resolution
- Every save sets `updatedAt = new Date().toISOString()` on the record
- Server uses `WHERE updated_at < EXCLUDED.updated_at` — latest timestamp wins
- Client always accepts the server's merged response
- Local-only fields (tile data) are preserved during merge

---

## Files to modify
- `index.html` — auth UI, sync panel, sync engine, updatedAt on saves
- `sw.js` — add Vercel to API_ORIGINS
- `package.json` — add dependencies

## New files to create
- `vercel.json` — config + CORS
- `api/auth/send-code.js`
- `api/auth/verify.js`
- `api/auth/me.js`
- `api/sync.js`
- `lib/db.js`
- `lib/auth.js`

## Verification
1. Deploy to Vercel → app loads in browser
2. Send magic code → receive email → verify → JWT stored
3. Create a route on desktop → save → check Neon DB has the row
4. Open on mobile (or second browser) → sign in → sync → route appears
5. Edit route on mobile → sync → desktop shows updated version
6. Delete route on desktop → sync on mobile → route removed
7. Go offline on mobile → app works normally from IndexedDB
8. Go online → sync catches up
