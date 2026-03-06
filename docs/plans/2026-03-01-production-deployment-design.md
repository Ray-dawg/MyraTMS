# MyraTMS Production Deployment — Design Document

**Date:** 2026-03-01
**Status:** Approved

## Goal

Deploy all three MyraTMS applications to Vercel with separate GitHub repos, full CI/CD pipelines, and production environment configuration.

## Architecture

Three independent Vercel projects, each backed by its own GitHub repo, sharing a single Neon PostgreSQL database (accessed only by MyraTMS API routes).

| App | Repo | Role | Vercel Project |
|-----|------|------|----------------|
| MyraTMS | `myratms` | TMS + API backend | myratms.vercel.app |
| DApp | `myra-driver` | Driver PWA | myra-driver.vercel.app |
| One_pager tracking | `myra-tracking` | Customer tracking | myra-tracking.vercel.app |

## Data Flow

```
DApp (driver) ──Bearer token──► MyraTMS API ◄──tracking token── One_pager
                                    │
                                    ▼
                              Neon PostgreSQL
```

## Deploy Order

1. MyraTMS first (provides API URLs)
2. One_pager tracking second (needs API URL)
3. DApp third (needs API URL)
4. MyraTMS redeploy (set CORS URLs for the other two apps)

## CI/CD

GitHub Actions per repo: lint + typecheck + test + build on PRs, auto-deploy main to Vercel.

## Pre-Deploy Code Changes

- Remove hardcoded localhost fallbacks from CORS/middleware
- Rename package.json names
- Create .env.example files
- Add GitHub Actions workflows

## Environment Variables

See deployment guide for complete inventory across all 3 apps.
