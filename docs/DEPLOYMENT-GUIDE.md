# MyraTMS Production Deployment Guide

Complete guide for deploying MyraTMS, Myra Driver (DApp), and Myra Tracking (One_pager) to Vercel with GitHub repos and CI/CD.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Complete API Key Inventory](#2-complete-api-key-inventory)
3. [Pre-Deploy Code Fixes](#3-pre-deploy-code-fixes)
4. [GitHub Repo Setup](#4-github-repo-setup)
5. [CI/CD Pipeline Setup](#5-cicd-pipeline-setup)
6. [Vercel Deployment — Step by Step](#6-vercel-deployment--step-by-step)
7. [Domain Configuration](#7-domain-configuration)
8. [Post-Deploy Verification](#8-post-deploy-verification)
9. [Ongoing Operations](#9-ongoing-operations)

---

## 1. Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Myra Driver    │     │     MyraTMS       │     │  Myra Tracking   │
│   (DApp PWA)     │     │  (Main TMS +API)  │     │  (One_pager)     │
│                  │     │                   │     │                  │
│ myra-driver.     │     │ myratms.          │     │ myra-tracking.   │
│ vercel.app       │     │ vercel.app        │     │ vercel.app       │
│                  │     │                   │     │                  │
│ Bearer token ────┼────►│ /api/*            │◄────┼─ Tracking token  │
│ auth             │     │                   │     │   auth           │
└─────────────────┘     │       │           │     └──────────────────┘
                         │       ▼           │
                         │ ┌───────────────┐ │
                         │ │ Neon Postgres  │ │
                         │ │ (shared DB)    │ │
                         │ └───────────────┘ │
                         └──────────────────┘
```

| App | GitHub Repo | Purpose | Dev Port |
|-----|-------------|---------|----------|
| **MyraTMS** | `myratms` | Full-stack TMS — admin UI + all API routes | 3000 |
| **DApp** | `myra-driver` | Driver PWA — mobile-first, GPS tracking | 3001 |
| **One_pager tracking** | `myra-tracking` | Customer tracking page — read-only, token access | 3002 |

**Key principle:** Only MyraTMS talks to the database. DApp and One_pager are pure frontends that call MyraTMS API routes over HTTPS.

---

## 2. Complete API Key Inventory

### MyraTMS — Environment Variables

#### Required (app will not function without these)

| Variable | Status | How to Get It |
|----------|--------|---------------|
| `DATABASE_URL` | **Active** | [Neon Console](https://console.neon.tech) > Project > Connection Details. Format: `postgresql://user:pass@host/db?sslmode=require` |
| `JWT_SECRET` | **Active** | Self-generated. Run: `openssl rand -base64 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | **Active** | [Mapbox Account](https://account.mapbox.com/access-tokens/) > Create token with Geocoding + Directions scopes |

#### Required for full functionality

| Variable | Status | How to Get It | What breaks without it |
|----------|--------|---------------|----------------------|
| `KV_REST_API_URL` | **Missing** | [Upstash Console](https://console.upstash.com) > Create Redis DB > REST API tab | Redis caching disabled — app falls back gracefully but slower |
| `KV_REST_API_TOKEN` | **Missing** | Same Upstash page as above | (same as above) |
| `XAI_API_KEY` | **Missing** | [x.ai Console](https://console.x.ai) > API Keys | AI chat assistant and AI rate estimation disabled |
| `BLOB_READ_WRITE_TOKEN` | **Missing** | Vercel Dashboard > Storage > Create Blob Store > Get token | Document uploads and POD image storage disabled |
| `NEXT_PUBLIC_APP_URL` | **Missing** | Your MyraTMS Vercel URL (e.g. `https://myratms.vercel.app`) | CORS rejects cross-origin requests from DApp and Tracking |
| `NEXT_PUBLIC_DRIVER_APP_URL` | **Missing** | Your DApp Vercel URL (e.g. `https://myra-driver.vercel.app`) | CORS blocks driver app API calls |
| `NEXT_PUBLIC_TRACKING_URL` | **Missing** | Your Tracking Vercel URL (e.g. `https://myra-tracking.vercel.app`) | Tracking emails contain broken localhost links |

#### Optional (features degrade gracefully)

| Variable | How to Get It | Feature |
|----------|---------------|---------|
| `SMTP_HOST` | Your email provider (e.g. `smtp.gmail.com`) | Tracking email notifications |
| `SMTP_PORT` | Usually `587` (TLS) | (same) |
| `SMTP_USER` | Email account username | (same) |
| `SMTP_PASS` | Email password or app-specific password | (same) |
| `FROM_EMAIL` | Sender address (e.g. `tracking@myratms.com`) | (same) |
| `FMCSA_API_KEY` | [FMCSA Portal](https://portal.fmcsa.dot.gov/WebServices) > Register | Carrier compliance auto-verification |
| `DAT_API_KEY` | Contact DAT sales rep | DAT RateView lane rates in quoting engine |
| `DAT_API_SECRET` | (same) | (same) |
| `TRUCKSTOP_API_KEY` | Contact Truckstop account rep | Truckstop rate data in quoting engine |
| `SAMSARA_API_KEY` | [Samsara Dashboard](https://cloud.samsara.com) > Settings > API | GPS positions from Samsara ELDs |
| `MOTIVE_API_KEY` | [Motive Dashboard](https://gomotive.com) > Developer Settings | GPS positions from Motive ELDs |

### DApp (Myra Driver) — Environment Variables

| Variable | Status | Value |
|----------|--------|-------|
| `NEXT_PUBLIC_API_URL` | **Needs prod URL** | MyraTMS production URL (e.g. `https://myratms.vercel.app`) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | **Active** | Same Mapbox token as MyraTMS |

### One_pager Tracking — Environment Variables

| Variable | Status | Value |
|----------|--------|-------|
| `NEXT_PUBLIC_API_URL` | **Needs prod URL** | MyraTMS production URL (e.g. `https://myratms.vercel.app`) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | **Active** | Same Mapbox token as MyraTMS |

---

## 3. Pre-Deploy Code Fixes

These changes must be made before the first production deploy. When you're ready, tell Claude Code to execute this section.

### 3a. Rename package.json names

| App | Current name | New name |
|-----|-------------|----------|
| MyraTMS | `my-v0-project` | `myratms` |
| DApp | `my-project` | `myra-driver` |
| One_pager | `my-project` | `myra-tracking` |

### 3b. Remove hardcoded localhost from MyraTMS

**Files to update:**

- `MyraTMS/middleware.ts` — Remove hardcoded localhost from `ALLOWED_ORIGINS`. Keep only env var sources. Add a development check:
  ```typescript
  const ALLOWED_ORIGINS = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_DRIVER_APP_URL,
    process.env.NEXT_PUBLIC_TRACKING_URL,
    // Allow localhost in development only
    ...(process.env.NODE_ENV === 'development' ? [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
    ] : []),
  ].filter(Boolean)
  ```

- `MyraTMS/lib/cors.ts` — Same pattern as middleware.ts above.

- `MyraTMS/app/api/loads/[id]/tracking-token/route.ts` — Remove `|| "http://localhost:3002"` fallback. Use env var only, throw if missing:
  ```typescript
  const trackingUrl = process.env.NEXT_PUBLIC_TRACKING_URL
  if (!trackingUrl) throw new Error('NEXT_PUBLIC_TRACKING_URL not configured')
  ```

- `MyraTMS/app/api/loads/[id]/send-tracking/route.ts` — Same fix.

- `MyraTMS/app/api/cron/fmcsa-reverify/route.ts` — Same fix for `NEXT_PUBLIC_APP_URL`.

### 3c. Create .env.example files

Each app needs an `.env.example` (committed to git) showing required variables without values:

**MyraTMS/.env.example:**
```env
# Required
DATABASE_URL=
JWT_SECRET=
NEXT_PUBLIC_MAPBOX_TOKEN=

# Required for full functionality
KV_REST_API_URL=
KV_REST_API_TOKEN=
XAI_API_KEY=
BLOB_READ_WRITE_TOKEN=

# Cross-app URLs (set after deploying all 3 apps)
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_DRIVER_APP_URL=
NEXT_PUBLIC_TRACKING_URL=

# Optional — Email notifications
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=

# Optional — External integrations
FMCSA_API_KEY=
DAT_API_KEY=
DAT_API_SECRET=
TRUCKSTOP_API_KEY=
SAMSARA_API_KEY=
MOTIVE_API_KEY=
```

**DApp/.env.example:**
```env
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_MAPBOX_TOKEN=
```

**One_pager tracking/.env.example:**
```env
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_MAPBOX_TOKEN=
```

---

## 4. GitHub Repo Setup

When you're ready to launch, Claude Code will execute these steps for you.

### For each app:

```bash
# 1. Initialize git (if not already)
cd MyraTMS  # or DApp, or "One_pager tracking"
git init

# 2. Create .gitignore (already exists for each app)

# 3. Initial commit
git add -A
git commit -m "feat: initial production release"

# 4. Create GitHub repo (requires gh CLI authenticated)
gh repo create YOUR_GITHUB_USERNAME/myratms --private --source=. --push
# Repeat with myra-driver and myra-tracking
```

### Repo naming:

| Local Directory | GitHub Repo Name |
|----------------|-----------------|
| `MyraTMS/` | `myratms` |
| `DApp/` | `myra-driver` |
| `One_pager tracking/` | `myra-tracking` |

---

## 5. CI/CD Pipeline Setup

Each repo gets a GitHub Actions workflow file. These run on every PR and on push to main.

### MyraTMS: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    name: Lint, Typecheck & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm exec tsc --noEmit
      - run: pnpm test

  build:
    name: Build Check
    runs-on: ubuntu-latest
    needs: quality
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

### DApp & One_pager: `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    name: Lint & Build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm build
```

### Vercel Auto-Deploy

Vercel automatically deploys when you push to main (once connected). No additional config needed — Vercel's GitHub integration handles:
- **Preview deploys** on every PR (unique URL per PR)
- **Production deploy** on merge to main
- **Automatic rollback** if build fails

---

## 6. Vercel Deployment — Step by Step

### Step 1: Deploy MyraTMS (must be first)

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import the `myratms` GitHub repo
3. **Framework preset:** Next.js (auto-detected)
4. **Root directory:** Leave blank (repo root)
5. **Build command:** `pnpm build` (auto-detected)
6. **Environment Variables** — Add all required vars:

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | (your Neon connection string) |
   | `JWT_SECRET` | (your secret) |
   | `NEXT_PUBLIC_MAPBOX_TOKEN` | (your Mapbox token) |
   | `KV_REST_API_URL` | (Upstash Redis URL) |
   | `KV_REST_API_TOKEN` | (Upstash Redis token) |
   | `XAI_API_KEY` | (xAI API key) |
   | `BLOB_READ_WRITE_TOKEN` | (Vercel Blob token — create Blob store in Vercel first) |

7. Click **Deploy**
8. Note the production URL (e.g. `https://myratms.vercel.app`)

### Step 2: Deploy Myra Tracking (One_pager)

1. Import `myra-tracking` repo on Vercel
2. **Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_API_URL` | `https://myratms.vercel.app` (from Step 1) |
   | `NEXT_PUBLIC_MAPBOX_TOKEN` | (your Mapbox token) |

3. Deploy
4. Note the URL (e.g. `https://myra-tracking.vercel.app`)

### Step 3: Deploy Myra Driver (DApp)

1. Import `myra-driver` repo on Vercel
2. **Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_API_URL` | `https://myratms.vercel.app` (from Step 1) |
   | `NEXT_PUBLIC_MAPBOX_TOKEN` | (your Mapbox token) |

3. Deploy
4. Note the URL (e.g. `https://myra-driver.vercel.app`)

### Step 4: Update MyraTMS with cross-app URLs

Go to Vercel > myratms project > Settings > Environment Variables. Add:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_APP_URL` | `https://myratms.vercel.app` |
| `NEXT_PUBLIC_DRIVER_APP_URL` | `https://myra-driver.vercel.app` |
| `NEXT_PUBLIC_TRACKING_URL` | `https://myra-tracking.vercel.app` |

Then redeploy MyraTMS: Vercel > Deployments > latest > "..." > Redeploy.

---

## 7. Domain Configuration

### Option A: Vercel Subdomains (Free, Immediate)

No action needed — apps are live at:
- `myratms.vercel.app`
- `myra-driver.vercel.app`
- `myra-tracking.vercel.app`

### Option B: Custom Domain

1. **Buy a domain** (e.g. `myratms.com` via Namecheap, Cloudflare, or Google Domains)
2. **Add to Vercel** — for each project:
   - Vercel > Project > Settings > Domains > Add Domain
   - Suggested mapping:

   | Subdomain | Vercel Project |
   |-----------|---------------|
   | `app.myratms.com` | myratms |
   | `driver.myratms.com` | myra-driver |
   | `track.myratms.com` | myra-tracking |

3. **Update DNS** — Vercel gives you CNAME records to add at your registrar
4. **Update env vars** — Change all URL variables to use the custom domains:
   - `NEXT_PUBLIC_APP_URL=https://app.myratms.com`
   - `NEXT_PUBLIC_DRIVER_APP_URL=https://driver.myratms.com`
   - `NEXT_PUBLIC_TRACKING_URL=https://track.myratms.com`
5. **Redeploy all 3 apps** after updating env vars

Vercel provides free SSL certificates automatically for custom domains.

---

## 8. Post-Deploy Verification

Run through this checklist after all 3 apps are deployed:

### MyraTMS
- [ ] Login page loads at production URL
- [ ] Can log in with existing credentials
- [ ] Dashboard loads with data from Neon
- [ ] Sidebar navigation works (Loads, Quotes, Shippers, Carriers, etc.)
- [ ] Quote generation works (navigate to /quotes, generate a benchmark quote)
- [ ] Settings > Integrations page loads
- [ ] Cron jobs configured (check Vercel > Project > Settings > Crons)

### Myra Driver (DApp)
- [ ] Login page loads at production URL
- [ ] Can log in with driver PIN
- [ ] Map screen renders (with Mapbox token)
- [ ] Loads list fetches from MyraTMS API (no CORS errors in console)
- [ ] PWA installable (check browser install prompt)
- [ ] Service worker registered (check DevTools > Application > Service Workers)

### Myra Tracking
- [ ] Tracking page loads with a valid token URL (e.g. `/track/{token}`)
- [ ] Map renders with route visualization
- [ ] Status timeline displays correctly
- [ ] SSE real-time updates connect (check Network tab for EventSource)
- [ ] Fallback canvas map works when Mapbox token removed

### Cross-App
- [ ] CORS: DApp can call MyraTMS API without errors
- [ ] CORS: Tracking page can call MyraTMS API without errors
- [ ] Tracking emails contain production URLs (not localhost)
- [ ] Booking a quoted load from MyraTMS creates a load visible in DApp

---

## 9. Ongoing Operations

### Database Migrations

Neon PostgreSQL migrations are manual SQL scripts in `MyraTMS/scripts/`. To run a new migration:

```bash
# From MyraTMS directory
node -e "
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const sql = neon(process.env.DATABASE_URL);
const migration = fs.readFileSync('scripts/NNN-migration-name.sql', 'utf8');
const cleaned = migration.replace(/^--.*$/gm, '');
const stmts = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0);
(async () => {
  for (const stmt of stmts) {
    await sql.query(stmt);
    console.log('OK:', stmt.substring(0, 60));
  }
})();
"
```

### Monitoring

- **Vercel Analytics:** Built into all 3 apps (page views, web vitals)
- **Vercel Logs:** Real-time function logs at Vercel > Project > Logs
- **Neon Dashboard:** Query performance and connection metrics
- **Upstash Dashboard:** Redis cache hit rates

### Vercel Cron Jobs (MyraTMS)

Already configured in `vercel.json`:
- `GET /api/cron/fmcsa-reverify` — Daily at 6:00 AM UTC
- `GET /api/cron/invoice-alerts` — Daily at 8:00 AM UTC

These only run on the production deployment (not preview deploys).

### Updating

Standard git workflow:
1. Create feature branch
2. Push — CI runs, Vercel creates preview deploy
3. Review PR + preview URL
4. Merge to main — Vercel auto-deploys to production

### Rollback

If a deploy breaks production:
1. Vercel > Project > Deployments
2. Find the last working deployment
3. Click "..." > "Promote to Production"
4. Instant rollback (no rebuild needed)

---

## Quick Reference Card

### Services & Dashboards

| Service | URL | Purpose |
|---------|-----|---------|
| Vercel | [vercel.com/dashboard](https://vercel.com/dashboard) | Hosting, deploys, logs |
| Neon | [console.neon.tech](https://console.neon.tech) | PostgreSQL database |
| Upstash | [console.upstash.com](https://console.upstash.com) | Redis cache |
| Mapbox | [account.mapbox.com](https://account.mapbox.com) | Maps, geocoding, directions |
| xAI | [console.x.ai](https://console.x.ai) | AI chat + rate estimation |
| GitHub | [github.com](https://github.com) | Source code, CI/CD |

### Cost Estimates (Free Tier Coverage)

| Service | Free Tier | Likely Cost at Launch |
|---------|-----------|----------------------|
| Vercel | 100GB bandwidth, 100 hrs compute/mo | Free |
| Neon | 0.5 GB storage, 1 compute | Free |
| Upstash | 10K commands/day | Free |
| Mapbox | 100K geocoding, 100K directions/mo | Free |
| xAI (Grok) | Pay-per-token | ~$5-20/mo depending on usage |
| Vercel Blob | 1 GB | Free |

Total estimated launch cost: **$0–20/month** (only AI usage has real cost).
