# Production Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all 3 MyraTMS apps (TMS, Driver, Tracking) production-ready with GitHub repos, CI/CD pipelines, and Vercel deployment — eliminating all hardcoded localhost references and adding proper environment configuration.

**Architecture:** Three separate GitHub repos, each deployed as independent Vercel projects. MyraTMS hosts all API routes; DApp and One_pager are frontend-only clients calling MyraTMS over HTTPS. Single shared Neon PostgreSQL database.

**Tech Stack:** Next.js 16 App Router, Neon PostgreSQL, Vercel, GitHub Actions, pnpm

---

## Task 1: Fix MyraTMS Localhost References

**Files:**
- Modify: `MyraTMS/middleware.ts` (lines 9-16)
- Modify: `MyraTMS/lib/cors.ts` (lines 3-10)
- Modify: `MyraTMS/app/api/loads/[id]/tracking-token/route.ts` (lines 35, 58)
- Modify: `MyraTMS/app/api/loads/[id]/send-tracking/route.ts` (line 61)
- Modify: `MyraTMS/app/api/cron/fmcsa-reverify/route.ts` (line 35)

### Step 1: Update middleware.ts CORS origins

Replace lines 9-16:
```typescript
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.NEXT_PUBLIC_DRIVER_APP_URL,
  process.env.NEXT_PUBLIC_TRACKING_URL,
].filter(Boolean) as string[]
```

With:
```typescript
const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.NEXT_PUBLIC_DRIVER_APP_URL,
  process.env.NEXT_PUBLIC_TRACKING_URL,
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"]
    : []),
].filter(Boolean) as string[]
```

### Step 2: Update lib/cors.ts CORS origins

Replace lines 3-10:
```typescript
const ALLOWED_ORIGINS = [
  "http://localhost:3000", // MyraTMS dev
  "http://localhost:3001", // Driver_App dev
  "http://localhost:3002", // One_pager tracking dev
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.NEXT_PUBLIC_DRIVER_APP_URL,
  process.env.NEXT_PUBLIC_TRACKING_URL,
].filter(Boolean) as string[]
```

With:
```typescript
const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.NEXT_PUBLIC_DRIVER_APP_URL,
  process.env.NEXT_PUBLIC_TRACKING_URL,
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"]
    : []),
].filter(Boolean) as string[]
```

### Step 3: Fix tracking-token route localhost fallback

In `app/api/loads/[id]/tracking-token/route.ts`, replace both occurrences:

Line 35 — replace:
```typescript
const trackingUrl = `${process.env.NEXT_PUBLIC_TRACKING_URL || "http://localhost:3002"}/track/${existing[0].token}`
```
With:
```typescript
const trackingBaseUrl = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
const trackingUrl = `${trackingBaseUrl}/track/${existing[0].token}`
```

Line 58 — replace:
```typescript
const trackingUrl = `${process.env.NEXT_PUBLIC_TRACKING_URL || "http://localhost:3002"}/track/${token}`
```
With:
```typescript
const trackingBaseUrl2 = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
const trackingUrl = `${trackingBaseUrl2}/track/${token}`
```

### Step 4: Fix send-tracking route localhost fallback

In `app/api/loads/[id]/send-tracking/route.ts`, replace line 61:
```typescript
const trackingUrl = `${process.env.NEXT_PUBLIC_TRACKING_URL || "http://localhost:3002"}/track/${token}`
```
With:
```typescript
const trackingBaseUrl = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
const trackingUrl = `${trackingBaseUrl}/track/${token}`
```

### Step 5: Fix FMCSA cron route localhost fallback

In `app/api/cron/fmcsa-reverify/route.ts`, replace line 35:
```typescript
const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
```
With:
```typescript
const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "")
```

### Step 6: Verify build

```bash
cd MyraTMS && pnpm build
```

### Step 7: Commit

```bash
git add middleware.ts lib/cors.ts app/api/loads/ app/api/cron/
git commit -m "fix: restrict localhost CORS to development only"
```

---

## Task 2: Rename Package Names + Create .env.example Files

**Files:**
- Modify: `MyraTMS/package.json` (line 2: name field)
- Modify: `DApp/package.json` (line 2: name field)
- Modify: `One_pager tracking/package.json` (line 2: name field)
- Create: `MyraTMS/.env.example`
- Create: `DApp/.env.example`
- Create: `One_pager tracking/.env.example`

### Step 1: Rename MyraTMS package.json

Change `"name": "my-v0-project"` to `"name": "myratms"`

### Step 2: Rename DApp package.json

Change `"name": "my-project"` to `"name": "myra-driver"`

### Step 3: Rename One_pager package.json

Change `"name": "my-project"` to `"name": "myra-tracking"`

### Step 4: Create MyraTMS/.env.example

```env
# === Required ===
DATABASE_URL=
JWT_SECRET=
NEXT_PUBLIC_MAPBOX_TOKEN=

# === Required for full functionality ===
KV_REST_API_URL=
KV_REST_API_TOKEN=
XAI_API_KEY=
BLOB_READ_WRITE_TOKEN=

# === Cross-app URLs (set after deploying all 3 apps) ===
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_DRIVER_APP_URL=
NEXT_PUBLIC_TRACKING_URL=

# === Optional — Email notifications ===
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
FROM_EMAIL=

# === Optional — External integrations ===
FMCSA_API_KEY=
DAT_API_KEY=
DAT_API_SECRET=
TRUCKSTOP_API_KEY=
SAMSARA_API_KEY=
MOTIVE_API_KEY=
```

### Step 5: Create DApp/.env.example

```env
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_MAPBOX_TOKEN=
```

### Step 6: Create One_pager tracking/.env.example

```env
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_MAPBOX_TOKEN=
```

### Step 7: Commit (per app)

```bash
cd MyraTMS && git add package.json .env.example && git commit -m "chore: rename package and add env example"
cd ../DApp && git add package.json .env.example && git commit -m "chore: rename package and add env example"
cd "../One_pager tracking" && git add package.json .env.example && git commit -m "chore: rename package and add env example"
```

---

## Task 3: Add CI/CD Workflows — MyraTMS

**Files:**
- Create: `MyraTMS/.github/workflows/ci.yml`

### Step 1: Create CI workflow

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
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      JWT_SECRET: test-secret-for-ci

  build:
    name: Build
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
      JWT_SECRET: test-secret-for-ci
```

### Step 2: Commit

```bash
cd MyraTMS && git add .github/ && git commit -m "ci: add GitHub Actions lint, typecheck, test, and build"
```

---

## Task 4: Add CI/CD Workflows — DApp

**Files:**
- Create: `DApp/.github/workflows/ci.yml`

### Step 1: Create CI workflow

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

### Step 2: Commit

```bash
cd DApp && git add .github/ && git commit -m "ci: add GitHub Actions lint and build"
```

---

## Task 5: Add CI/CD Workflow — One_pager Tracking

**Files:**
- Create: `One_pager tracking/.github/workflows/ci.yml`

### Step 1: Create CI workflow

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

### Step 2: Commit

```bash
cd "One_pager tracking" && git add .github/ && git commit -m "ci: add GitHub Actions lint and build"
```

---

## Task 6: Initialize GitHub Repos + Push

This task should be run when ready for launch. Requires `gh` CLI authenticated.

### Step 1: Initialize and push MyraTMS

```bash
cd MyraTMS
git init   # if not already
git add -A
git commit -m "feat: MyraTMS v1.0 — freight brokerage TMS with quoting engine"
gh repo create YOUR_USERNAME/myratms --private --source=. --push
```

### Step 2: Initialize and push DApp

```bash
cd DApp
git init
git add -A
git commit -m "feat: Myra Driver v1.0 — driver PWA with GPS tracking"
gh repo create YOUR_USERNAME/myra-driver --private --source=. --push
```

### Step 3: Initialize and push One_pager tracking

```bash
cd "One_pager tracking"
git init
git add -A
git commit -m "feat: Myra Tracking v1.0 — customer shipment tracking"
gh repo create YOUR_USERNAME/myra-tracking --private --source=. --push
```

---

## Task 7: Deploy to Vercel

Manual steps in Vercel dashboard. Follow the order in `docs/DEPLOYMENT-GUIDE.md` Section 6:

### Step 1: Deploy MyraTMS first
- Import `myratms` repo at vercel.com/new
- Add all env vars from the guide (DATABASE_URL, JWT_SECRET, MAPBOX, KV, XAI, BLOB)
- Deploy and note the production URL

### Step 2: Deploy One_pager tracking
- Import `myra-tracking` repo
- Set `NEXT_PUBLIC_API_URL` = MyraTMS URL from Step 1
- Set `NEXT_PUBLIC_MAPBOX_TOKEN`
- Deploy and note the URL

### Step 3: Deploy DApp
- Import `myra-driver` repo
- Set `NEXT_PUBLIC_API_URL` = MyraTMS URL from Step 1
- Set `NEXT_PUBLIC_MAPBOX_TOKEN`
- Deploy and note the URL

### Step 4: Update MyraTMS cross-app URLs
- In Vercel > myratms > Settings > Environment Variables, add:
  - `NEXT_PUBLIC_APP_URL` = MyraTMS URL
  - `NEXT_PUBLIC_DRIVER_APP_URL` = DApp URL
  - `NEXT_PUBLIC_TRACKING_URL` = Tracking URL
- Redeploy MyraTMS

### Step 5: Run post-deploy verification

Follow checklist in `docs/DEPLOYMENT-GUIDE.md` Section 8.

---

## Task 8: Add GitHub Secrets for CI

For each repo, add secrets at GitHub > Repo > Settings > Secrets > Actions:

### MyraTMS secrets:
- `DATABASE_URL` — Neon connection string (needed for CI build + test)

### DApp & One_pager tracking:
- No secrets needed (no server-side env vars required for build)

---

## Verification

After all tasks complete:

1. **Build all 3 apps locally:** `pnpm build` in each directory — all should succeed
2. **Verify no hardcoded localhost in production paths:** `grep -r "localhost" --include="*.ts" --include="*.tsx" MyraTMS/app MyraTMS/lib MyraTMS/middleware.ts` should only show results inside `NODE_ENV === "development"` blocks
3. **Verify .env.example exists** in all 3 app directories
4. **Verify CI workflows exist** in all 3 `.github/workflows/ci.yml`
5. **Post-deploy:** Follow full checklist in `docs/DEPLOYMENT-GUIDE.md` Section 8
