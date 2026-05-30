# Alert & notification environment variables

Add these to `backend/.env`:

```env
# Comma-separated admin emails for CRITICAL alerts (SMTP only)
ADMIN_ALERT_EMAILS=ops@example.com,dev@example.com

# Minutes to dedupe repeated alerts (default: 60)
ALERT_DEDUP_COOLDOWN_MINUTES=60

# Optional From header for alert emails (falls back to MAIL_FROM / SMTP user)
ALERT_EMAIL_FROM=alerts@yourdomain.com
```

**Severity rules**

| Severity  | Stored in admin UI | Email sent        |
|-----------|--------------------|-------------------|
| INFO      | Yes                | No                |
| WARNING   | Yes                | No                |
| CRITICAL  | Yes                | Yes (throttled, see below)   |

### CRITICAL email throttling

Repeated occurrences of the **same** alert (dedupe) do **not** send a new email each time.

| When | Email sent |
|------|------------|
| First CRITICAL occurrence for that alert | Immediately (`initial`) |
| Still active after **1 hour** | One reminder (`1h`) |
| Still active after **6 hours** | One reminder (`6h`) |
| Still active after **24 hours** | One reminder (`24h`) |

Example: same issue **20 times in 5 minutes** → **1 row**, `occurrenceCount = 20`, **1 email**.

### MongoDB disconnect alerts (dev / Atlas)

Brief MongoDB blips (common with Atlas or `npm run dev` restarts) no longer email immediately.
A CRITICAL email is sent only if Mongo stays disconnected for **30 seconds** (`MONGODB_DISCONNECT_ALERT_DELAY_MS`).
Restarting the server (Ctrl+C) does **not** send a disconnect alert.

Emails include a full **“What happened”** section (not just a short error code).

SMTP must be configured (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`) for critical alert emails.

**Indexes (production)**

```bash
cd backend && node scripts/create-indexes.js
```

## Test script

Full suite (creates alerts, verifies DB/dedupe/API, optional cleanup):

```bash
cd backend
node scripts/test-alert-system.js --keep --yes   # keep rows in UI; send CRITICAL emails
node scripts/test-alert-system.js --plan         # print matrix only
node scripts/test-alert-system.js --api-only     # HTTP tests only (server must run)
node scripts/test-alert-system.js --cleanup      # remove last run's test alerts
```

Or: `npm run test:alerts` (uses `--keep --yes`).
