/**
 * Seed carriers from FMCSA L&I bulk file (Engine 2 Production Ship Roadmap A.1).
 *
 * Source: scripts/data/carrier_2026_05_26.txt (5,369 rows, FMCSA L&I subset).
 * Pure local-file scrape — no FMCSA API calls. Geocoding via Mapbox (token in .env.local).
 *
 * Output: up to ~165 carriers in tenant_id=2 (LEGACY_DEFAULT_TENANT_ID), all tagged
 * carrier_status='prospect'. Ranker matches them freely; Dispatcher refuses
 * prospect assignment (see lib/workers/dispatcher-worker.ts gate).
 *
 * Equipment inference: keyword heuristics on company name. US carriers are
 * SAMPLED with bias toward reefer/flatbed name patterns so the equipment
 * buckets are balanced (otherwise ~95% would be Dry Van).
 *
 * Lanes: synthesized from home state via lookup table; on_time_rate=0.92
 * placeholder will be refined by the Feedback Agent from real performance data.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/seed-carriers-from-fmcsa.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/seed-carriers-from-fmcsa.ts
 *
 * Flags: --dry-run, --verbose
 */

import { Pool, neonConfig } from "@neondatabase/serverless"
import ws from "ws"
import fs from "node:fs"
import path from "node:path"

neonConfig.webSocketConstructor = ws as any

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has("--dry-run")
const VERBOSE = args.has("--verbose")

const TENANT_ID = 2 // LEGACY_DEFAULT_TENANT_ID — see lib/auth.ts:30
const MAPBOX_KEY = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
const MAPBOX_RATE_LIMIT_MS = 100

const CARRIER_FILE = path.join(process.cwd(), "scripts", "data", "carrier_2026_05_26.txt")

const TARGET_CA = 100 // best-effort; cap at whatever's eligible in file
const TARGET_US = 100
// 100/60/40 fallback split — see memory file project_engine2_a1_seed_inprogress.md.
const EQUIP_TARGETS: Record<EquipmentType, number> = {
  "Dry Van": 100,
  Reefer: 60,
  Flatbed: 40,
}

type EquipmentType = "Dry Van" | "Reefer" | "Flatbed"

// ============================================================
// LANE_TEMPLATES — state/province code → plausible outbound lanes.
// Feedback Agent overwrites on_time_rate / load_count from real data
// after Sprint 6A drains. Fallback to a single generic lane if unmapped.
// ============================================================
type LaneTemplate = { origin: string; dest: string }
const LANE_TEMPLATES: Record<string, LaneTemplate[]> = {
  ON: [
    { origin: "Ontario", dest: "Quebec" },
    { origin: "Ontario", dest: "Michigan" },
    { origin: "Ontario", dest: "Illinois" },
  ],
  QC: [
    { origin: "Quebec", dest: "Ontario" },
    { origin: "Quebec", dest: "New York" },
    { origin: "Quebec", dest: "Massachusetts" },
  ],
  BC: [
    { origin: "British Columbia", dest: "Alberta" },
    { origin: "British Columbia", dest: "Washington" },
    { origin: "British Columbia", dest: "California" },
  ],
  AB: [
    { origin: "Alberta", dest: "British Columbia" },
    { origin: "Alberta", dest: "Saskatchewan" },
    { origin: "Alberta", dest: "Texas" },
  ],
  MB: [
    { origin: "Manitoba", dest: "Ontario" },
    { origin: "Manitoba", dest: "Saskatchewan" },
    { origin: "Manitoba", dest: "Minnesota" },
  ],
  SK: [
    { origin: "Saskatchewan", dest: "Alberta" },
    { origin: "Saskatchewan", dest: "Manitoba" },
    { origin: "Saskatchewan", dest: "North Dakota" },
  ],
  NS: [
    { origin: "Nova Scotia", dest: "New Brunswick" },
    { origin: "Nova Scotia", dest: "Quebec" },
    { origin: "Nova Scotia", dest: "Ontario" },
  ],
  NB: [
    { origin: "New Brunswick", dest: "Nova Scotia" },
    { origin: "New Brunswick", dest: "Quebec" },
    { origin: "New Brunswick", dest: "Maine" },
  ],
  IL: [
    { origin: "Illinois", dest: "Indiana" },
    { origin: "Illinois", dest: "Wisconsin" },
    { origin: "Illinois", dest: "Ohio" },
  ],
  TX: [
    { origin: "Texas", dest: "California" },
    { origin: "Texas", dest: "Louisiana" },
    { origin: "Texas", dest: "Oklahoma" },
  ],
  CA: [
    { origin: "California", dest: "Arizona" },
    { origin: "California", dest: "Nevada" },
    { origin: "California", dest: "Oregon" },
  ],
  GA: [
    { origin: "Georgia", dest: "Florida" },
    { origin: "Georgia", dest: "Tennessee" },
    { origin: "Georgia", dest: "South Carolina" },
  ],
  OH: [
    { origin: "Ohio", dest: "Pennsylvania" },
    { origin: "Ohio", dest: "Michigan" },
    { origin: "Ohio", dest: "Indiana" },
  ],
  MI: [
    { origin: "Michigan", dest: "Ohio" },
    { origin: "Michigan", dest: "Illinois" },
    { origin: "Michigan", dest: "Indiana" },
  ],
  PA: [
    { origin: "Pennsylvania", dest: "New York" },
    { origin: "Pennsylvania", dest: "Ohio" },
    { origin: "Pennsylvania", dest: "New Jersey" },
  ],
  NY: [
    { origin: "New York", dest: "Pennsylvania" },
    { origin: "New York", dest: "New Jersey" },
    { origin: "New York", dest: "Massachusetts" },
  ],
  FL: [
    { origin: "Florida", dest: "Georgia" },
    { origin: "Florida", dest: "Alabama" },
    { origin: "Florida", dest: "South Carolina" },
  ],
  IN: [
    { origin: "Indiana", dest: "Illinois" },
    { origin: "Indiana", dest: "Ohio" },
    { origin: "Indiana", dest: "Kentucky" },
  ],
  TN: [
    { origin: "Tennessee", dest: "Georgia" },
    { origin: "Tennessee", dest: "Kentucky" },
    { origin: "Tennessee", dest: "North Carolina" },
  ],
  NC: [
    { origin: "North Carolina", dest: "Virginia" },
    { origin: "North Carolina", dest: "South Carolina" },
    { origin: "North Carolina", dest: "Tennessee" },
  ],
  WI: [
    { origin: "Wisconsin", dest: "Illinois" },
    { origin: "Wisconsin", dest: "Minnesota" },
    { origin: "Wisconsin", dest: "Michigan" },
  ],
  MN: [
    { origin: "Minnesota", dest: "Wisconsin" },
    { origin: "Minnesota", dest: "Iowa" },
    { origin: "Minnesota", dest: "North Dakota" },
  ],
  MO: [
    { origin: "Missouri", dest: "Illinois" },
    { origin: "Missouri", dest: "Kansas" },
    { origin: "Missouri", dest: "Tennessee" },
  ],
  DEFAULT: [{ origin: "United States", dest: "United States" }],
}

// ============================================================
// Types
// ============================================================
interface CarrierRow {
  docket: string // idx 0 (MCxxxx / MXxxxx / FFxxxx)
  dot: string // idx 1
  forHireAuth: string // idx 4 (A=Active)
  bipdRequiredK: number // idx 18 (in $1000s — "00750" = $750k)
  cargoRequiredK: number // idx 21
  legalName: string // idx 26
  city: string // idx 29
  state: string // idx 30
  country: string // idx 31 (US/CA/MX)
  zip: string // idx 32
  phone: string // idx 33
}

interface EnrichedCarrier extends CarrierRow {
  equipmentType: EquipmentType
  lat: number | null
  lng: number | null
  liabilityInsurance: number
  cargoInsurance: number
}

// ============================================================
// CSV parser — fields are `"..."` wrapped, separated by `,`.
// Quote-aware: split on the literal `","` between fields, then strip the
// surrounding `"` from the head and tail. Commas inside content are preserved.
// ============================================================
function parseCsvLine(line: string): string[] {
  if (!line) return []
  const trimmed = line.replace(/^"/, "").replace(/"$/, "")
  return trimmed.split('","')
}

function parseInsuranceK(field: string): number {
  const n = parseInt(field || "0", 10)
  return Number.isFinite(n) ? n : 0
}

function parseCarrierFile(): CarrierRow[] {
  const raw = fs.readFileSync(CARRIER_FILE, "utf8")
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0)
  const rows: CarrierRow[] = []
  for (const line of lines) {
    const fields = parseCsvLine(line)
    if (fields.length < 34) continue
    rows.push({
      docket: fields[0],
      dot: fields[1].replace(/^0+/, ""),
      forHireAuth: fields[4],
      bipdRequiredK: parseInsuranceK(fields[18]),
      cargoRequiredK: parseInsuranceK(fields[21]),
      legalName: fields[26],
      city: fields[29],
      state: fields[30],
      country: fields[31],
      zip: fields[32],
      phone: fields[33],
    })
  }
  return rows
}

// ============================================================
// Equipment heuristic. Name-only keyword match (no cargo-carried API).
// Order matters: Reefer wins over Dry Van; Flatbed wins over Dry Van.
// ============================================================
const REEFER_RE = /refriger|reefer|cold|frozen|food|produce|meat|beef|poultry|dairy|fresh|milk|fish|seafood|beverage|ice cream|perishable/i
const FLATBED_RE = /flatbed|heavy haul|oversize|building material|machinery|steel|lumber|construction|pipe|coil|metal|concrete|brick|timber|aggregate|excavat|crane|equipment haul/i

function inferEquipment(companyName: string): EquipmentType {
  if (REEFER_RE.test(companyName)) return "Reefer"
  if (FLATBED_RE.test(companyName)) return "Flatbed"
  return "Dry Van"
}

// ============================================================
// Mapbox forward-geocode with in-memory cache + rate limit.
// ============================================================
const geocodeCache = new Map<string, { lat: number; lng: number } | null>()
let lastGeocodeCall = 0
async function geocode(city: string, state: string, country: string): Promise<{ lat: number; lng: number } | null> {
  const key = `${city}|${state}|${country}`.toLowerCase()
  if (geocodeCache.has(key)) return geocodeCache.get(key) ?? null
  if (!MAPBOX_KEY || !city) {
    geocodeCache.set(key, null)
    return null
  }
  const wait = MAPBOX_RATE_LIMIT_MS - (Date.now() - lastGeocodeCall)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastGeocodeCall = Date.now()
  try {
    const query = encodeURIComponent(`${city}, ${state}, ${country}`)
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${MAPBOX_KEY}&limit=1`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      geocodeCache.set(key, null)
      return null
    }
    const data = await res.json()
    const feature = data?.features?.[0]
    if (!feature) {
      geocodeCache.set(key, null)
      return null
    }
    const [lng, lat] = feature.center as [number, number]
    const result = { lat, lng }
    geocodeCache.set(key, result)
    return result
  } catch (e) {
    if (VERBOSE) console.error(`[Mapbox] geocode "${key}" failed:`, e)
    geocodeCache.set(key, null)
    return null
  }
}

function synthesizeLanes(state: string, equipment: EquipmentType): Array<{ origin: string; dest: string; equipment: EquipmentType }> {
  const tpl = LANE_TEMPLATES[(state || "").toUpperCase()] ?? LANE_TEMPLATES.DEFAULT
  return tpl.map((t) => ({ origin: t.origin, dest: t.dest, equipment }))
}

function makeId(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}-${ts}${rand}`
}

// ============================================================
// Per-carrier transaction: carriers + carrier_equipment + carrier_lanes.
// ============================================================
async function insertCarrier(pool: Pool, c: EnrichedCarrier): Promise<string | null> {
  const id = makeId("CAR")
  const insuranceExpiry = new Date()
  insuranceExpiry.setFullYear(insuranceExpiry.getFullYear() + 1)
  const expiryIso = insuranceExpiry.toISOString().slice(0, 10)
  const mcNumber = c.docket.startsWith("MC") ? c.docket : ""

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const inserted = await client.query(
      `INSERT INTO carriers (
         id, tenant_id, company, mc_number, dot_number,
         contact_name, contact_phone,
         authority_status, insurance_status, insurance_expiry,
         liability_insurance, cargo_insurance,
         safety_rating, last_fmcsa_sync,
         home_city, home_lat, home_lng,
         communication_rating, on_time_percent,
         carrier_status,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         '', $6,
         'Active', 'Active', $7,
         $8, $9,
         'Not Rated', NOW(),
         $10, $11, $12,
         3.0, 90,
         'prospect',
         NOW(), NOW()
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, TENANT_ID, c.legalName, mcNumber, c.dot, c.phone || "", expiryIso, c.liabilityInsurance, c.cargoInsurance, c.city, c.lat, c.lng],
    )
    if (inserted.rows.length === 0) {
      await client.query("ROLLBACK")
      return null
    }

    await client.query(
      `INSERT INTO carrier_equipment (id, tenant_id, carrier_id, equipment_type, truck_count)
       VALUES ($1, $2, $3, $4, 10)
       ON CONFLICT (tenant_id, carrier_id, equipment_type) DO NOTHING`,
      [makeId("CE"), TENANT_ID, id, c.equipmentType],
    )

    const lanes = synthesizeLanes(c.state, c.equipmentType)
    for (const lane of lanes) {
      await client.query(
        `INSERT INTO carrier_lanes (
           id, tenant_id, carrier_id, origin_region, dest_region, equipment_type,
           load_count, on_time_rate, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0.92, NOW())
         ON CONFLICT (tenant_id, carrier_id, origin_region, dest_region, equipment_type) DO NOTHING`,
        [makeId("CL"), TENANT_ID, id, lane.origin, lane.dest, lane.equipment],
      )
    }

    await client.query("COMMIT")
    return id
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {})
    if (e?.code === "23505") {
      // Unique violation, most likely (tenant_id, mc_number) — skip silently.
      if (VERBOSE) console.warn(`[seed] dup skipped: ${c.legalName} (MC ${mcNumber})`)
      return null
    }
    console.error(`[seed] insert failed for ${c.legalName}:`, e?.message ?? e)
    return null
  } finally {
    client.release()
  }
}

// ============================================================
// Enrichment — only geocode and insurance derivation. No FMCSA calls.
// ============================================================
async function enrichCarrier(row: CarrierRow): Promise<EnrichedCarrier> {
  const equipmentType = inferEquipment(row.legalName)
  const geo = await geocode(row.city, row.state, row.country)

  // Master file's required-amount columns are in $1000s. Defaults to industry
  // standard if blank: $750k BIPD, $100k cargo.
  const liabilityInsurance = row.bipdRequiredK > 0 ? row.bipdRequiredK * 1000 : 750000
  const cargoInsurance = row.cargoRequiredK > 0 ? row.cargoRequiredK * 1000 : 100000

  return {
    ...row,
    equipmentType,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    liabilityInsurance,
    cargoInsurance,
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set")
    process.exit(1)
  }
  if (!MAPBOX_KEY) {
    console.warn("[seed] NEXT_PUBLIC_MAPBOX_TOKEN not set — carriers will lack home_lat/lng (Ranker proximity score will degrade)")
  }

  console.log(`[seed] mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`)
  console.log(`[seed] tenant_id: ${TENANT_ID}`)
  console.log(`[seed] parsing FMCSA file: ${CARRIER_FILE}`)

  const allRows = parseCarrierFile()
  console.log(`[seed] parsed ${allRows.length} rows`)

  const eligible = allRows.filter(
    (r) =>
      r.forHireAuth === "A" &&
      (r.country === "US" || r.country === "CA") &&
      r.legalName.trim().length > 0 &&
      r.dot &&
      r.dot !== "0",
  )
  const fileCA = eligible.filter((r) => r.country === "CA")
  const fileUS = eligible.filter((r) => r.country === "US")
  console.log(`[seed] eligible (active for-hire US/CA): ${eligible.length}  (CA=${fileCA.length}, US=${fileUS.length})`)

  // Pre-bucket the US pool by name-inferred equipment so we can sample with bias.
  const usBucketed: Record<EquipmentType, CarrierRow[]> = { "Dry Van": [], Reefer: [], Flatbed: [] }
  for (const r of fileUS) usBucketed[inferEquipment(r.legalName)].push(r)
  console.log(`[seed] US pool inferred buckets: DryVan=${usBucketed["Dry Van"].length} Reefer=${usBucketed.Reefer.length} Flatbed=${usBucketed.Flatbed.length}`)

  // Shuffle each bucket and take the first N for biased equipment balance.
  // Dry Van gets 3x oversample because we use it to top up when specialty
  // buckets (Reefer/Flatbed) are short of their targets.
  const usSelected: CarrierRow[] = []
  for (const eq of Object.keys(EQUIP_TARGETS) as EquipmentType[]) {
    const want = Math.ceil(EQUIP_TARGETS[eq] / 2)
    const oversample = eq === "Dry Van" ? 3 : 2
    const shuffled = [...usBucketed[eq]].sort(() => Math.random() - 0.5)
    usSelected.push(...shuffled.slice(0, Math.min(want * oversample, shuffled.length)))
  }
  const usCandidates = usSelected

  // CA: all eligible (~65), no augmentation since no FMCSA API.
  const caCandidates = fileCA.slice(0, TARGET_CA + 20)

  const candidates = [...caCandidates, ...usCandidates]
  console.log(`[seed] enriching ${caCandidates.length} CA + ${usCandidates.length} US = ${candidates.length} candidates (geocoding via Mapbox)...`)

  const enriched: EnrichedCarrier[] = []
  let i = 0
  for (const row of candidates) {
    i++
    if (i % 25 === 0) console.log(`[seed]   enriched ${i}/${candidates.length}`)
    enriched.push(await enrichCarrier(row))
  }

  // Bucket final pool by equipment × country.
  const buckets: Record<string, { CA: EnrichedCarrier[]; US: EnrichedCarrier[] }> = {
    "Dry Van": { CA: [], US: [] },
    Reefer: { CA: [], US: [] },
    Flatbed: { CA: [], US: [] },
  }
  for (const e of enriched) {
    const arr = buckets[e.equipmentType]?.[e.country as "CA" | "US"]
    if (arr) arr.push(e)
  }

  console.log(`[seed] equipment × country distribution after enrichment:`)
  for (const eq of Object.keys(buckets) as EquipmentType[]) {
    console.log(`[seed]   ${eq.padEnd(8)}: CA=${buckets[eq].CA.length} US=${buckets[eq].US.length}`)
  }

  // Final selection: take all scarce specialty carriers (Reefer + Flatbed) first,
  // then fill the rest with Dry Van up to TOTAL_TARGET. Specialty equipment is the
  // bottleneck for Ranker exercise; pool depth comes from Dry Van top-up.
  const TOTAL_TARGET = TARGET_CA + TARGET_US // 200
  const finalCarriers: EnrichedCarrier[] = []
  for (const eq of ["Reefer", "Flatbed"] as EquipmentType[]) {
    finalCarriers.push(...buckets[eq].CA, ...buckets[eq].US)
  }
  const need = TOTAL_TARGET - finalCarriers.length
  if (need > 0) {
    const dvCa = buckets["Dry Van"].CA
    const dvUs = buckets["Dry Van"].US
    const halfCa = Math.min(Math.ceil(need / 2), dvCa.length)
    const halfUs = Math.min(need - halfCa, dvUs.length)
    finalCarriers.push(...dvCa.slice(0, halfCa))
    finalCarriers.push(...dvUs.slice(0, halfUs))
    // If still short (e.g., CA exhausted), top up the other side.
    const stillShort = TOTAL_TARGET - finalCarriers.length
    if (stillShort > 0) {
      finalCarriers.push(...dvUs.slice(halfUs, halfUs + stillShort))
    }
  }

  const caFinal = finalCarriers.filter((c) => c.country === "CA").length
  const usFinal = finalCarriers.filter((c) => c.country === "US").length
  console.log(`[seed] final selection: ${finalCarriers.length} (CA=${caFinal}, US=${usFinal})`)

  if (DRY_RUN) {
    console.log(`[seed] DRY RUN — sample preview (first 20):`)
    for (const c of finalCarriers.slice(0, 20)) {
      const name = c.legalName.slice(0, 36).padEnd(36)
      const loc = `${c.city}, ${c.state}`.slice(0, 25).padEnd(25)
      const geo = c.lat != null ? "geo" : " — "
      console.log(`  ${c.country} ${c.equipmentType.padEnd(8)} | ${name} | ${loc} | DOT ${c.dot.padEnd(10)} | ${geo} | $${(c.liabilityInsurance / 1000).toFixed(0)}k/$${(c.cargoInsurance / 1000).toFixed(0)}k`)
    }
    console.log(`[seed] (would insert ${finalCarriers.length} carriers; re-run without --dry-run to commit)`)
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let ok = 0
  let skipped = 0
  try {
    for (const c of finalCarriers) {
      const id = await insertCarrier(pool, c)
      if (id) ok++
      else skipped++
    }
  } finally {
    await pool.end()
  }
  console.log(`[seed] inserted ${ok}, skipped ${skipped}, total attempted ${finalCarriers.length}`)
  console.log(`[seed] done.`)
}

main().catch((err) => {
  console.error("[seed] FATAL:", err)
  process.exit(1)
})
