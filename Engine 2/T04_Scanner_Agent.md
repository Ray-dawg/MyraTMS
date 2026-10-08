# T-04: AGENT 1 — LOAD SCANNER SERVICE SPECIFICATION

**Myra Logistics — Technical Specification**
**Version:** 1.0 | **Date:** April 2, 2026 | **Owner:** Patrice Penda
**Classification:** Technical — Engineering Only

---

## Purpose

Agent 1 (Scanner) polls load board APIs on a schedule, normalizes data into a unified schema, deduplicates across sources, and pushes qualified loads into the pipeline. It is the entry point for every load in Engine 2.

---

## 1. Existing Foundation (from T-01 Audit)

The Scanner is **~60% built.** Key existing assets:

| Component | Status | Location | Notes |
|---|---|---|---|
| Load board search route | WORKING (mock fallback) | `/api/loadboard/search` | Searches DAT/Truckstop, aggregates, deduplicates, Redis-cached 4h TTL |
| Load board import route | WORKING | `/api/loadboard/import` | Imports single external load into TMS `loads` table |
| Redis caching | CONNECTED | Upstash Redis | Already configured for load board result caching |
| DAT integration | API_KEY_SLOT_READY | Settings → Integrations tab | OAuth2 pattern coded, needs API key |
| Truckstop integration | API_KEY_SLOT_READY | Settings → Integrations tab | API key slot exists |
| 123Loadboard integration | STUBBED | Referenced in loadboard search | Mentioned in code but no API implementation |
| Integration test route | WORKING | `/api/integrations/[id]/test` | Can test DAT/Truckstop connections |

### What's Missing for Agent 1

- **Continuous polling** — current search is on-demand (user clicks "Search" in the load board UI). Needs cron-triggered polling.
- **Pipeline writes** — current import writes to TMS `loads` table. Agent 1 should write to `pipeline_loads` table instead.
- **Normalized schema** — current search returns raw API responses. Needs mapping to unified `raw_load` schema.
- **Multi-source dedup** — current dedup works within a single search. Needs cross-source dedup across polling intervals.
- **Queue integration** — no connection to BullMQ. After writing to `pipeline_loads`, must enqueue to `qualify-queue`.

---

## 2. Unified Load Schema

Every load from every source gets mapped to this normalized interface before entering the pipeline:

```typescript
interface RawLoad {
  // Source identification
  loadId: string;                // Original load ID from source
  loadBoardSource: string;       // 'dat' | '123lb' | 'truckstop' | 'truckpath' | 'loadlink' | 'manual'
  sourceUrl: string | null;      // Direct URL to the posting (for audit)
  
  // Geography
  originCity: string;
  originState: string;           // Province code for Canada (ON, QC, etc.)
  originCountry: string;         // 'CA' | 'US'
  originLat: number | null;
  originLng: number | null;
  destinationCity: string;
  destinationState: string;
  destinationCountry: string;
  destinationLat: number | null;
  destinationLng: number | null;
  
  // Load details
  equipmentType: string;         // Normalized: 'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck'
  commodity: string | null;
  weightLbs: number | null;
  distanceMiles: number | null;  // May need to be computed via Mapbox if not provided
  
  // Dates
  pickupDate: string;            // ISO date
  pickupTimeWindow: string | null; // "08:00-12:00" or null
  deliveryDate: string | null;
  deliveryTimeWindow: string | null;
  
  // Rate
  postedRate: number | null;     // null if "call for rate"
  postedRateCurrency: string;    // 'USD' | 'CAD'
  rateType: string;              // 'all_in' | 'per_mile' | 'per_km'
  
  // Shipper contact
  shipperCompany: string | null;
  shipperContactName: string | null;
  shipperPhone: string | null;
  shipperEmail: string | null;
  
  // Metadata
  postedAt: string;              // When the load was first posted
  expiresAt: string | null;      // When the posting expires
  scannedAt: string;             // When Agent 1 captured it
}
```

### Source-Specific Mapping

Each load board API returns different field names and formats. The scanner includes a mapper per source:

```typescript
// Mapper registry
const mappers: Record<string, (raw: any) => RawLoad> = {
  dat: mapDATLoad,
  '123lb': map123LoadboardLoad,
  truckstop: mapTruckstopLoad,
  truckpath: mapTruckPathLoad,
  loadlink: mapLoadlinkLoad,
};

function mapDATLoad(datResponse: DATLoadResponse): RawLoad {
  return {
    loadId: datResponse.matchId,
    loadBoardSource: 'dat',
    originCity: datResponse.origin.city,
    originState: datResponse.origin.stateProvince,
    originCountry: datResponse.origin.country === 'CAN' ? 'CA' : 'US',
    // ... complete mapping
    equipmentType: normalizeEquipment(datResponse.equipmentType),
    postedRate: datResponse.rate?.amount || null,
    postedRateCurrency: datResponse.rate?.currency || 'USD',
    // ...
  };
}

// Equipment normalization across sources
function normalizeEquipment(raw: string): string {
  const map: Record<string, string> = {
    'V': 'dry_van', 'VAN': 'dry_van', 'DRY VAN': 'dry_van',
    'F': 'flatbed', 'FLAT': 'flatbed', 'FLATBED': 'flatbed',
    'R': 'reefer', 'REEFER': 'reefer', 'REFRIGERATED': 'reefer',
    'T': 'tanker', 'TANK': 'tanker', 'TANKER': 'tanker',
    'SD': 'step_deck', 'STEP DECK': 'step_deck',
  };
  return map[raw.toUpperCase()] || 'dry_van';
}
```

---

## 3. Polling Strategy

### Schedule

| Scenario | Interval | Hours | Notes |
|---|---|---|---|
| Business hours (9AM–5PM ET) | Every 5 minutes | Mon–Fri | Peak load posting activity |
| Extended hours (5PM–9PM ET) | Every 15 minutes | Mon–Fri | Reduced but still active |
| Off hours (9PM–9AM ET) | Every 30 minutes | Daily | Catch overnight postings |
| Weekends | Every 30 minutes | Sat–Sun | Minimal activity |

### Implementation

Use Vercel Cron Jobs (existing pattern in codebase — `/api/cron/*` routes already use `CRON_SECRET` auth):

```typescript
// /api/cron/scan-loadboards/route.ts
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const sources = getActiveSources(); // ['dat', '123lb', 'truckstop', etc.]
  let totalScanned = 0;
  let totalNew = 0;
  
  for (const source of sources) {
    try {
      const loads = await fetchFromSource(source);
      const mapped = loads.map(l => mappers[source](l));
      const { inserted, duplicates } = await writeToDb(mapped);
      totalScanned += mapped.length;
      totalNew += inserted;
      
      // Enqueue new loads to qualify-queue
      for (const load of inserted) {
        await qualifyQueue.add('qualify', buildQualifyPayload(load), {
          priority: load.postedRate ? Math.round(load.postedRate) : 0,
        });
      }
    } catch (error) {
      console.error(`Scanner error for ${source}:`, error);
      // Continue with other sources — don't let one failure stop all
    }
  }
  
  return Response.json({ totalScanned, totalNew, sources: sources.length });
}
```

### Rate Limiting

Each load board API has its own rate limits. The scanner respects these:

| Source | Known Limits | Strategy |
|---|---|---|
| DAT | OAuth2 token-based, unclear public rate limit | Cache aggressively (4h), limit to 12 requests/hour |
| 123Loadboard | TBD (in onboarding) | Start conservative: 6 requests/hour |
| Truckstop | TBD (in onboarding) | Start conservative: 6 requests/hour |
| Loadlink | TBD | Start conservative: 6 requests/hour |

---

## 4. Deduplication

### Cross-Source Deduplication

The same load can appear on multiple load boards. Dedup by:

```sql
-- Primary dedup: exact load_id + source combo
UNIQUE (load_id, load_board_source)

-- Cross-source dedup: same shipper + origin + destination + pickup date + equipment
-- Check before insert:
SELECT id FROM pipeline_loads
WHERE shipper_phone = $1
  AND origin_city = $2 AND origin_state = $3
  AND destination_city = $4 AND destination_state = $5
  AND pickup_date = $6
  AND equipment_type = $7
  AND created_at > NOW() - INTERVAL '24 hours'
LIMIT 1;
```

If a cross-source duplicate is found, skip the insert but log the duplicate for data quality tracking.

### Within-Source Freshness

The scanner only processes loads posted since the last successful scan. Use `updated_since` parameter (DAT supports this) or compare `postedAt` against last scan timestamp stored in Redis:

```typescript
const lastScan = await redis.get(`scanner:last_scan:${source}`) || new Date(Date.now() - 3600000).toISOString();
const newLoads = results.filter(l => l.postedAt > lastScan);
await redis.set(`scanner:last_scan:${source}`, new Date().toISOString());
```

---

## 5. CSV Fallback Import

Until load board APIs go live, Patrice can manually import loads. The existing bulk import system (`/api/import/execute`) handles CSV → `loads` table. The Scanner adds a parallel path: CSV → `pipeline_loads` table.

```typescript
// /api/pipeline/import/route.ts
// Accepts a CSV file, maps to RawLoad[], writes to pipeline_loads, enqueues to qualify-queue
// Reuses the existing CSV parsing logic from /api/import (PapaParse with BOM handling)
```

This lets you test Agents 2–7 on real load data while waiting for API approvals.

---

## 6. Pipeline Write Pattern

When the scanner ingests a load:

```typescript
async function writeToDb(loads: RawLoad[]): Promise<{ inserted: PipelineLoad[]; duplicates: number }> {
  const inserted: PipelineLoad[] = [];
  let duplicates = 0;
  
  for (const load of loads) {
    try {
      const result = await db.query(`
        INSERT INTO pipeline_loads (
          load_id, load_board_source, 
          origin_city, origin_state, origin_country,
          destination_city, destination_state, destination_country,
          pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
          distance_miles, distance_km,
          shipper_company, shipper_contact_name, shipper_phone, shipper_email,
          posted_rate, posted_rate_currency, rate_type,
          stage, stage_updated_at, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'scanned',NOW(),'scanner-v1')
        ON CONFLICT (load_id, load_board_source) DO UPDATE SET updated_at = NOW()
        RETURNING *
      `, [/* params */]);
      
      if (result.rows[0]) inserted.push(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') { // unique constraint violation
        duplicates++;
      } else {
        throw error;
      }
    }
  }
  
  return { inserted, duplicates };
}
```

---

## 7. Distance Computation

Some load board postings include mileage, others don't. When `distanceMiles` is null, compute via the existing Mapbox Directions service (already built in the quoting engine — `distance_cache` table with 30-day cache).

```typescript
// Reuse existing distance service
import { getDistance } from '@/lib/distance';

if (!load.distanceMiles && load.originLat && load.destinationLat) {
  const distance = await getDistance(
    { lat: load.originLat, lng: load.originLng },
    { lat: load.destinationLat, lng: load.destinationLng }
  );
  load.distanceMiles = distance.miles;
  load.distanceKm = distance.km;
}
```

---

## 8. Monitoring

| Metric | How to Track | Alert Threshold |
|---|---|---|
| Loads scanned per hour | Count inserts to pipeline_loads per hour | < 10 during business hours = source may be down |
| Dedup rate | Duplicates / total scanned | > 90% = polling too frequently or source stale |
| API errors per source | Error count per source per hour | > 5 errors/hour for any single source |
| Scan latency | Time from cron trigger to all sources processed | > 60 seconds = investigate |
| Queue depth (qualify-queue) | BullMQ getWaitingCount() | > 500 = qualifier may be backed up |

---

## 9. File Structure

```
/app/api/cron/scan-loadboards/route.ts    — Cron trigger endpoint
/app/api/pipeline/import/route.ts          — CSV fallback import
/lib/scanner/
  index.ts                                 — Main scanner orchestrator
  sources/
    dat.ts                                 — DAT API client + mapper
    loadboard123.ts                        — 123Loadboard API client + mapper
    truckstop.ts                           — Truckstop API client + mapper
    truckpath.ts                           — TruckPath API client + mapper
    loadlink.ts                            — Loadlink API client + mapper
  mappers.ts                               — Equipment normalization, schema mapping utilities
  dedup.ts                                 — Cross-source deduplication logic
  types.ts                                 — RawLoad interface and related types
```

---

*End of document. The scanner is the mouth of the pipeline. No data in = no revenue out.*
