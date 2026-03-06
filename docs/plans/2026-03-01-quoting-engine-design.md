# Quoting Engine Design

## Overview

Cascading rate intelligence system for MyraTMS. Accepts a load request (origin, destination, equipment, weight, pickup date) and returns an instant rate quote. Uses 6 data sources in priority order, never returns empty.

## Architecture

```
Quote Request → Distance Service → Region Normalizer → Rate Cascade → Fuel Surcharge → Margin Engine → Quote Assembly
```

### Rate Source Cascade (Priority Order)

1. **Historical loads** — own completed loads on lane (5+ = HIGH confidence)
2. **DAT RateView API** — spot + contract rates (requires `dat_api_key`)
3. **Truckstop Rate Analysis API** — spot market data (requires `truckstop_api_key`)
4. **Manual rate cache** — manually seeded lane rates (degrades with age)
5. **AI estimation** — Claude/OpenAI with structured context (requires `ai_api_key`)
6. **Benchmark formula** — hardcoded CAD rate table by distance band + equipment (always works)

### Confidence Scoring

| Level | Score | Sources | UI Treatment |
|-------|-------|---------|-------------|
| HIGH | 0.80-1.0 | 5+ historical or fresh DAT/Truckstop | Green badge |
| MEDIUM | 0.50-0.79 | 1-4 historical, stale cache, AI, blended | Yellow badge |
| LOW | 0.0-0.49 | Benchmark only | Red badge, manual review |

## New Database Tables

- `quotes` — full quote records with pricing, confidence, lifecycle tracking
- `integrations` — API key storage for external services (DAT, Truckstop, AI, Mapbox)
- `distance_cache` — cached Mapbox distance calculations (30-day TTL)
- `fuel_index` — weekly diesel price records for fuel surcharge
- `quote_corrections` — per-source per-lane correction factors from feedback loop

## New Library Modules

| Module | Path | Purpose |
|--------|------|---------|
| Quote orchestrator | `lib/quoting/index.ts` | Full pipeline orchestration |
| Rate cascade | `lib/quoting/cascade.ts` | 6-source waterfall logic |
| Confidence scoring | `lib/quoting/confidence.ts` | Score calculation |
| Margin engine | `lib/quoting/margin.ts` | Shipper relationship + confidence-based margins |
| Feedback loop | `lib/quoting/feedback.ts` | Accuracy tracking + correction factors |
| Benchmark rates | `lib/rates/benchmark.ts` | Hardcoded CAD rate table |
| Fuel surcharge | `lib/rates/fuel-index.ts` | NRCan diesel × distance calculation |
| DAT client | `lib/rates/dat-client.ts` | DAT RateView API integration |
| Truckstop client | `lib/rates/truckstop-client.ts` | Truckstop Rate Analysis API |
| AI estimator | `lib/rates/ai-estimator.ts` | AI-powered rate estimation |
| Distance service | `lib/geo/distance-service.ts` | Mapbox geocode + directions + cache |
| Region mapper | `lib/geo/region-mapper.ts` | Coordinates → Ontario region names |

## New API Routes

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/quotes` | GET, POST | List quotes, create new quote |
| `/api/quotes/[id]` | GET, PATCH | Quote detail, update status |
| `/api/quotes/[id]/book` | POST | Convert quote to load |
| `/api/quotes/[id]/feedback` | PATCH | Record actual carrier cost |
| `/api/integrations` | GET, POST | List/upsert integration settings |
| `/api/integrations/[id]/test` | POST | Test connection for an integration |
| `/api/rates` | GET, POST, DELETE | Manual rate cache CRUD |
| `/api/rates/import` | POST | Bulk CSV import of lane rates |
| `/api/fuel-index` | GET, POST | Fuel price records |

## New Pages

| Page | Path | Purpose |
|------|------|---------|
| New Quote | `app/quotes/page.tsx` | Quote form with address autocomplete + result display |
| Quote History | `app/quotes/history/page.tsx` | Filterable table of all quotes + conversion metrics |
| Quote Analytics | `app/quotes/analytics/page.tsx` | Performance dashboard (accuracy, win rate, source usage) |
| Integrations | `app/settings/integrations/page.tsx` | API key management cards |
| Rate Management | `app/settings/rates/page.tsx` | Manual rate cache table + CSV import |

## Conventions

- IDs: `QT-${Date.now().toString(36).toUpperCase()}`
- References: `MYR-Q-YYYY-NNNN` (sequential counter)
- DB columns: snake_case; TypeScript interfaces: camelCase
- SWR hooks added to `lib/api.ts`
- Navigation: "Quotes" in sidebar between Loads and Shippers
- Shadcn/UI + Lucide icons + Sonner toasts
