# ROC Shift Scheduler — Production Build

Serverless schedule generator for **ISOC** and **SCE/SCM Desk**, built on
Cloudflare Workers + D1.

---

## What's new (production build)

### Bug fixes

| # | Description |
|---|-------------|
| 1 | **Solver: month-boundary rest rule broken** — `canAssign()` compared shift *type strings* (`'night'`) against actual shift *codes* (`'N'`, `'NC'`), so the Night→Day rest rule was never enforced across month boundaries. Fixed in `solver.js`. |
| 2 | **Wrong schedule loaded on dept switch** — `GET /api/schedules` had no department filter, so switching from ISOC to SCE returned the most-recently-generated schedule regardless of department. Fixed: `?department=` query param now honoured. |
| 3 | **Coverage warning banner never showed** — the frontend checked `notes.includes('warning')` on a string that starts with `"Warnings:"` — case mismatch. Fixed to parse properly. |
| 4 | **Grid cell click reloaded entire schedule** — caused full re-render and scroll-jump on every cell edit. Fixed: optimistic UI update + background data sync, no re-render. |
| 5 | **`/api/schedules/:id/mine` 500 on missing schedule** — now returns 404 cleanly. |
| 6 | **Assignment patch didn't verify row exists** — now returns 404 if the assignment isn't found. |
| 7 | **`exportBtn` could be clicked with no schedule** — now guarded with a toast. |
| 8 | **Stack traces leaked to clients in production** — `index.js` now only exposes `stack` when `env.ENVIRONMENT === 'development'`. |
| 9 | **`alert()` used throughout** — replaced with a non-blocking toast notification system. |
| 10 | **Non-admins couldn't see their own leave** — `GET /api/leave` now allows staff to fetch their own leave without admin role. |

### New features

| Feature | Where |
|---------|-------|
| **PIN reset (admin)** | Admin → Staff Manager → Reset PIN. Clears `pin_set` flag + invalidates sessions. New API: `POST /api/auth/reset-pin` |
| **Staff Manager UI** | Add staff, change roles (admin↔staff), deactivate accounts. New APIs: `PATCH /api/staff/:id`, `DELETE /api/staff/:id` |
| **Shift swap requests** | Staff can request a shift swap with a colleague; admins approve or reject. New table: `swap_requests`. New APIs: `GET/POST /api/swap-requests`, `PATCH/DELETE /api/swap-requests/:id` |
| **"My Leave" tab** | Staff can see their own leave for the selected month without needing admin access. |
| **Coverage summary row** | A compact day-by-day coverage count bar above the grid, colour-coded green/red against minimums. |
| **My schedule filter** | "All days / Working only / Days off" chips on the My Schedule tab. |
| **Toast system** | Replaces all `alert()` calls with non-blocking bottom-right toasts. |
| **Loading overlay** | Full-screen spinner with status text during generate/load operations. |
| **Keyboard shortcuts** | `Esc` closes modals; `Alt+1–6` switches tabs. |
| **Sidebar navigation** | Permanent left sidebar with role-gated sections (My Workspace vs Admin). |
| **Optimistic cell edits** | Grid cells update instantly on click; rollback on API failure. |
| **Health endpoint** | `GET /api/health` — useful for uptime monitoring. |
| **`department_id` on schedules** | Migration `0003_prod.sql` adds this column so dept-filtered queries work. |
| **Role-based department lock** | Staff are locked to their own department; admins can switch freely. |

---

## Setup

### 1. Install Wrangler

```
npm install -g wrangler
wrangler login
```

### 2. D1 databases and deployment targets

The existing production database is **`raw-ter-shift`**. Its ID is configured in
`wrangler.toml`; do not create a replacement database or substitute an ID from
another Cloudflare account.

The isolated non-production database is **`raw-ter-shift-preview`**. The
`routesa` and `shiftsroutes` preview configurations both bind to this database.
The five repository migrations have been applied there and recorded in
`d1_migrations`. The production database has deliberately been left untouched.

Non-production Workers Builds upload unpublished versions using
`wrangler.routesa.preview.toml` or `wrangler.shiftsroutes.preview.toml`.
These configurations use the preview database and disable Workers.dev and
version-preview URLs. The branch build command is `wrangler versions upload`,
which uploads a version without deploying it to traffic.

The default-branch triggers remain production deployment triggers. They run
`wrangler deploy` against the production configuration when `main` is built;
merging this PR is therefore a production-release action and must happen only
after production migrations, secrets, and release checks have been approved.

### 3. Apply ordered migrations

```bash
# Local development
npm run db:migrate:local

# Isolated Cloudflare preview database
npm run db:migrate:preview

# Production — only after backup, schema review, and explicit release approval
npm run db:migrate:remote
```

The ordered migrations live in `migrations/`. Do not execute them out of order.
For a brand-new D1 database, apply all migrations in order. For an existing database
that was previously initialized with `wrangler d1 execute --file`, stop first:
inspect the live schema and Wrangler's `d1_migrations` history, back up the database,
and reconcile the baseline before using `migrations apply`. Do not replay 0001–0003
against populated tables. The repository cannot determine whether a remote database
has already had those SQL files applied.
Migration 0004 adds one-time enrollment, salted PBKDF2 PIN storage and login
throttling. Existing legacy SHA-256 PINs are upgraded after the next successful
login. Migration 0005 seeds Patrick after the auth columns exist.

The preview database has been initialized with migrations 0001–0005 and
verified to contain 16 seeded staff across ISOC and SCE, the expected auth and
scheduling tables, and migration records for all five files. The production
database remains uninitialized; do not apply the remote migration command until
the release has been explicitly authorized.

Set the Worker secret `INITIAL_ADMIN_ENROLLMENT_SECRET` before first use. Use a
long random secret (at least 32 random bytes) and deliver it securely to the
initial admin only. Admins issue one-time enrollment codes when resetting staff
PINs; codes are displayed once and must be shared privately.

### 4. Dev

```
wrangler dev
```

### 5. Deploy

```
wrangler deploy
```

---

## Admin workflow

1. Pick **Department** and **Month** from the controls bar.
2. In **Leave Manager**, add any locked leave days before generating.
3. Click **Generate** → the solver fills the roster.
4. Review the **Team Grid** — coverage warnings appear in the red banner;
   the coverage row shows day/night headcounts per day.
5. Click any cell to cycle it manually (D → N → O → L). Overridden cells are
   outlined in amber.
6. When satisfied, click **Publish** to lock the schedule as the continuity
   baseline for next month.
7. Use **Export CSV** to download the schedule for printing.

### PIN management

If a staff member forgets their PIN: **Staff Manager → Reset PIN**. This clears
their PIN and signs them out everywhere. They'll set a new PIN on next login.

### Shift swaps

Staff submit swap requests from the **Shift Swaps** tab. Admins see all pending
requests and approve or reject them from the same tab.

---

## API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | none | Health check |
| GET | `/api/auth/people` | none | Staff list for login picker |
| POST | `/api/auth/set-pin` | none | First-time PIN setup |
| POST | `/api/auth/login` | none | Sign in |
| POST | `/api/auth/logout` | session | Sign out |
| GET | `/api/auth/me` | session | Current user |
| POST | `/api/auth/reset-pin` | **admin** | Clear another staff member's PIN |
| GET | `/api/departments` | session | List departments |
| GET | `/api/staff` | session | List staff (optional `?department=`) |
| POST | `/api/staff` | **admin** | Add staff |
| GET | `/api/staff/:id` | session | Single staff record |
| PATCH | `/api/staff/:id` | **admin** | Update name / role |
| DELETE | `/api/staff/:id` | **admin** | Deactivate staff |
| GET | `/api/leave` | session | Leave (staff: own only; admin: all) |
| POST | `/api/leave` | **admin** | Add leave |
| DELETE | `/api/leave/:id` | **admin** | Remove leave |
| GET | `/api/swap-requests` | session | List swap requests |
| POST | `/api/swap-requests` | session | Submit swap request |
| PATCH | `/api/swap-requests/:id` | **admin** | Approve / reject |
| DELETE | `/api/swap-requests/:id` | session | Cancel (own request) |
| POST | `/api/schedules/generate` | **admin** | Generate schedule |
| GET | `/api/schedules` | session | List schedules (`?month=`, `?department=`) |
| GET | `/api/schedules/:id` | session | Schedule + assignments |
| GET | `/api/schedules/:id/mine` | session | My shifts + co-workers |
| PATCH | `/api/schedules/:id/assignment` | **admin** | Manual override |
| POST | `/api/schedules/:id/publish` | **admin** | Publish |
| GET | `/api/schedules/:id/export` | session | Download CSV |

## Security and release notes

- The Worker source is `index.js`; static assets are served from `public/`.
  Wrangler configuration points to these committed paths.
- Non-admin staff receive only their own department's roster, schedule details
  and CSV exports. Authorization is enforced by the Worker, not only the UI.
- Published schedules are immutable. Corrections require a new draft version.
- Approving a swap applies both assignment changes to the latest editable draft
  and updates the request status together.
- New PINs are exactly six digits, PBKDF2-derived with a per-user random salt.
  Legacy PIN hashes are upgraded after successful authentication.
- Session cookies are random 256-bit secrets; only SHA-256 verifiers are stored
  in D1. Sessions expire after seven days and are invalidated on PIN reset.
- Failed PIN attempts are throttled per staff identifier and Cloudflare-observed
  client IP. Raw IP addresses are not stored in the attempts table.
- The old v2 ZIP was removed from the current branch because it contained
  unauthenticated API routes. It must not be deployed or restored without a
  complete authentication and authorization implementation.
- `npm test` runs the solver regression suite. CI checks JavaScript syntax and
  solver invariants. A green CI run is required before merge.
- Non-production Workers Builds upload unpublished versions to `routesa` and
  `shiftsroutes` using isolated preview D1 configuration; no branch build
  deploys traffic or writes to the production database.
- Production D1 `raw-ter-shift` is configured but has not been migrated.
  Production deployment triggers remain attached to `main`; do not merge or
  push to `main` until the production release is approved.

## Required environment configuration

| Variable | Purpose |
|---|---|
| `INITIAL_ADMIN_ENROLLMENT_SECRET` | One-time bootstrap for the initial admin account; store as a Worker secret only |
| `ENVIRONMENT` | Set to `production` in production; stack traces remain hidden |
| Production D1 | Existing `raw-ter-shift` database, configured in `wrangler.toml` |
| Preview D1 | Isolated `raw-ter-shift-preview` database, configured in the two preview Wrangler files |
