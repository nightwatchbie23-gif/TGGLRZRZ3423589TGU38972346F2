# TGGLR License Server

Serverless license verification and management API for Vercel, backed by Supabase.

## Requirements

- Node.js 20+
- A Supabase project with a `licenses` table containing: `license_key`, `is_active`, `hwid`
- Optional columns: `expires_at` (timestamptz), `last_used_at` (timestamptz)

The code detects optional columns at runtime. If `expires_at` is missing, all licenses behave as
Lifetime licenses. If `last_used_at` is missing, verification simply skips the update.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side Supabase key (fallback: `SUPABASE_KEY`) |
| `LICENSE_ADMIN_TOKEN` | Yes for management | Bearer token for `/api/licenses` (fallback: `ADMIN_API_KEY`) |

These values are read only inside serverless functions and are never returned to clients.

## Database migration (optional)

Apply `migrations/001_add_license_timestamps.sql` manually in the Supabase SQL editor if you want
expiration dates and last-used tracking. It uses `ADD COLUMN IF NOT EXISTS`, does not create or
drop tables, and does not modify existing rows.

## Verification API

`POST /api/verify` — unchanged request format:

```json
{ "license_key": "TGGLR-ABC123", "hwid": "device-fingerprint" }
```

Behavior:

- First successful verification binds the HWID atomically (only when `hwid IS NULL`).
- A different HWID is rejected with `401`.
- If two devices race to bind, one wins; the same device receives success, a different device
  receives `409`.
- Disabled and expired licenses are rejected. `expires_at = NULL` means Lifetime.
- `last_used_at` is updated after successful verification when the column exists.

Status codes: `200` verified/activated, `400` invalid request, `401` HWID mismatch, `403` disabled
or expired, `404` unknown key, `405` wrong method, `409` binding conflict, `500` server error.

All responses have the shape:

```json
{ "success": true, "message": "License verified successfully" }
```

Errors add a stable `code` field, e.g. `{ "success": false, "message": "License expired", "code": "LICENSE_EXPIRED" }`.

## Management API

Every request requires `Authorization: Bearer <LICENSE_ADMIN_TOKEN>` or `x-api-key: <token>`.
Keep this token and the Supabase service-role key server-side only; never ship them in a client
application.

### List

`GET /api/licenses?limit=50&offset=0&status=all&q=TGGLR`

- `status`: `all`, `active`, `disabled`, `expired`, `lifetime`
- `limit`: 1–200 (default 50)
- `q`: partial license-key search

### Create

`POST /api/licenses`

```json
{ "duration": "5m", "license_key": "optional-custom-key", "is_active": true }
```

Provide either `duration` or an ISO `expires_at`, not both. The key is generated when omitted.

### Update

`PATCH /api/licenses`

```json
{ "license_key": "TGGLR-ABC123", "action": "disable" }
```

Actions:

| Action | Body fields | Effect |
| --- | --- | --- |
| `enable` | — | Sets `is_active = true` |
| `disable` | — | Sets `is_active = false` |
| `reset_hwid` | — | Sets `hwid = NULL` (allows rebinding) |
| `update` | `is_active`, `duration`, or `expires_at` | Updates the given fields |

`update` with a `duration` recalculates expiry from the current time. Use `"L"` for Lifetime.

### Delete

`DELETE /api/licenses?license_key=TGGLR-ABC123`

Deletes a single license record. This is the only destructive operation and requires admin auth.

## Duration format

| Input | Meaning |
| --- | --- |
| `5d` | 5 days |
| `5w` | 5 weeks |
| `5m` | 5 months |
| `15m` | 15 months |
| `5y` | 5 years |
| `10y` | 10 years |
| `L` / `lifetime` | Lifetime (`expires_at = NULL`) |

Any positive integer is accepted. Months and years use UTC calendar arithmetic with day-of-month
clamping (for example, Jan 31 + 1 month = Feb 28/29). `m` means months, not minutes.

## Testing

Tests use Node's built-in test runner and need no extra dependencies:

```bash
npm test
npm run test:watch
```

Coverage includes verification, HWID binding and races, expiration, Lifetime, invalid input,
schema fallbacks, database failures, and management authorization.

## Deployment

Deploying the `api/` directory on Vercel works as before; no `vercel.json` is required. Set the
environment variables in the Vercel project settings and deploy the repository. Do not deploy
automatically from scripts.
