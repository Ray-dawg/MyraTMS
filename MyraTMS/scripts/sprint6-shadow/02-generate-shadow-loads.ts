/**
 * Sprint 6A — synthetic load generator.
 *
 * Generates N realistic-shaped loads with TEST_ prefix and submits them
 * via the existing POST /api/pipeline/import. Designed mix:
 *
 *   ~25% pass-all (good lanes, decent margin, recent dates) — should qualify
 *   ~30% margin-fail (rate too low for lane benchmark) — should disqualify
 *   ~20% lane-fail (origin in tier-3 region) — should disqualify
 *   ~15% equipment-mismatch — should disqualify
 *   ~10% freshness-fail (pickup date stale or too far out) — should disqualify
 *
 * Realistic phones use the +1-555-01XX NANP-reserved fictional range
 * (assigned by the FCC for fictional use in films/TV; will never reach
 * a real phone). Triple-safety: the loads are submitted with
 * MAX_CONCURRENT_CALLS=0 so even if the phone WERE real, no call would
 * be placed.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=100
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/02-generate-shadow-loads.ts --count=50 --base-url=http://localhost:3000
 */

interface RawLoadInput {
  loadId: string;
  loadBoardSource: 'manual';
  originCity: string;
  originState: string;
  originCountry: 'CA' | 'US';
  destinationCity: string;
  destinationState: string;
  destinationCountry: 'CA' | 'US';
  equipmentType: string;
  weightLbs: number;
  distanceMiles: number;
  pickupDate: string;
  deliveryDate: string;
  postedRate: number;
  postedRateCurrency: 'CAD' | 'USD';
  rateType: 'all_in';
  shipperCompany: string;
  shipperContactName: string;
  shipperPhone: string;
  shipperEmail: string;
}

const GOOD_LANES: Array<{ origin: [string, string, 'CA' | 'US']; destination: [string, string, 'CA' | 'US']; miles: number }> = [
  { origin: ['Toronto', 'ON', 'CA'], destination: ['Sudbury', 'ON', 'CA'], miles: 250 },
  { origin: ['Toronto', 'ON', 'CA'], destination: ['Montreal', 'QC', 'CA'], miles: 335 },
  { origin: ['Toronto', 'ON', 'CA'], destination: ['Ottawa', 'ON', 'CA'], miles: 280 },
  { origin: ['Toronto', 'ON', 'CA'], destination: ['Detroit', 'MI', 'US'], miles: 230 },
  { origin: ['Calgary', 'AB', 'CA'], destination: ['Edmonton', 'AB', 'CA'], miles: 185 },
  { origin: ['Calgary', 'AB', 'CA'], destination: ['Vancouver', 'BC', 'CA'], miles: 605 },
  { origin: ['Vancouver', 'BC', 'CA'], destination: ['Seattle', 'WA', 'US'], miles: 145 },
  { origin: ['Edmonton', 'AB', 'CA'], destination: ['Saskatoon', 'SK', 'CA'], miles: 325 },
];

const OBSCURE_LANES: Array<{ origin: [string, string, 'CA' | 'US']; destination: [string, string, 'CA' | 'US']; miles: number }> = [
  { origin: ['Yellowknife', 'NT', 'CA'], destination: ['Iqaluit', 'NU', 'CA'], miles: 1500 },
  { origin: ['Whitehorse', 'YT', 'CA'], destination: ['Anchorage', 'AK', 'US'], miles: 700 },
  { origin: ['Thunder Bay', 'ON', 'CA'], destination: ['Churchill', 'MB', 'CA'], miles: 950 },
  { origin: ['Yellowknife', 'NT', 'CA'], destination: ['Inuvik', 'NT', 'CA'], miles: 800 },
];

const EQUIPMENT_TYPES = ['Dry Van', 'Reefer', 'Flatbed'] as const;
const RARE_EQUIPMENT = ['step_deck', 'tanker', 'lowboy', 'hopper'] as const;

const SHIPPER_NAMES = [
  'Northern Mine Supply Co', 'Pacific Coast Logistics', 'Sun Belt Freight',
  'Midwest Brokerage Inc', 'Beacon Logistics', 'Cascade Shipping LLC',
  'Maple Leaf Distribution', 'Prairie Truck Lines', 'Trans-Canada Cargo',
  'Atlantic Provinces Freight', 'Boreal Logistics Group', 'Canso Trucking',
];

const CONTACT_NAMES = [
  'Jean-Marc Tremblay', 'Sarah Chen', 'Michael O\'Brien', 'Aisha Patel',
  'David Nguyen', 'Emily Johnson', 'Carlos Mendez', 'Priya Singh',
  'James Walker', 'Rachel Kim',
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** +1-555-01XX is the NANP reserved range for fictional use. Will never reach a real phone. */
function fictionalPhone(): string {
  const last2 = String(randInt(0, 99)).padStart(2, '0');
  return `+1555010${last2}${randInt(0, 99).toString().padStart(2, '0')}`;
}

function pickupDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

function generateGoodLoad(idx: number): RawLoadInput {
  const lane = randItem(GOOD_LANES);
  const equipment = randItem(EQUIPMENT_TYPES);
  // Healthy posted rate: $2.50–$3.50/mi → puts margin solidly above benchmark
  const ratePerMile = 2.5 + Math.random() * 1;
  const postedRate = Math.round(lane.miles * ratePerMile);
  return {
    loadId: `TEST_GOOD_${idx}`,
    loadBoardSource: 'manual',
    originCity: lane.origin[0],
    originState: lane.origin[1],
    originCountry: lane.origin[2],
    destinationCity: lane.destination[0],
    destinationState: lane.destination[1],
    destinationCountry: lane.destination[2],
    equipmentType: equipment,
    weightLbs: randInt(20000, 44000),
    distanceMiles: lane.miles,
    pickupDate: pickupDateInDays(randInt(2, 5)),
    deliveryDate: pickupDateInDays(randInt(3, 7)),
    postedRate,
    postedRateCurrency: lane.origin[2] === 'CA' ? 'CAD' : 'USD',
    rateType: 'all_in',
    shipperCompany: `TEST_${randItem(SHIPPER_NAMES)}`,
    shipperContactName: randItem(CONTACT_NAMES),
    shipperPhone: fictionalPhone(),
    shipperEmail: `test_${idx}@example.test`,
  };
}

function generateMarginFailLoad(idx: number): RawLoadInput {
  const lane = randItem(GOOD_LANES);
  const equipment = randItem(EQUIPMENT_TYPES);
  // Anemic posted rate: $1.20–$1.60/mi → below carrier cost on most lanes
  const ratePerMile = 1.2 + Math.random() * 0.4;
  const postedRate = Math.round(lane.miles * ratePerMile);
  return {
    loadId: `TEST_MARGINFAIL_${idx}`,
    loadBoardSource: 'manual',
    originCity: lane.origin[0],
    originState: lane.origin[1],
    originCountry: lane.origin[2],
    destinationCity: lane.destination[0],
    destinationState: lane.destination[1],
    destinationCountry: lane.destination[2],
    equipmentType: equipment,
    weightLbs: randInt(20000, 44000),
    distanceMiles: lane.miles,
    pickupDate: pickupDateInDays(randInt(2, 5)),
    deliveryDate: pickupDateInDays(randInt(3, 7)),
    postedRate,
    postedRateCurrency: lane.origin[2] === 'CA' ? 'CAD' : 'USD',
    rateType: 'all_in',
    shipperCompany: `TEST_${randItem(SHIPPER_NAMES)}`,
    shipperContactName: randItem(CONTACT_NAMES),
    shipperPhone: fictionalPhone(),
    shipperEmail: `test_${idx}@example.test`,
  };
}

function generateLaneFailLoad(idx: number): RawLoadInput {
  const lane = randItem(OBSCURE_LANES);
  return {
    loadId: `TEST_LANEFAIL_${idx}`,
    loadBoardSource: 'manual',
    originCity: lane.origin[0],
    originState: lane.origin[1],
    originCountry: lane.origin[2],
    destinationCity: lane.destination[0],
    destinationState: lane.destination[1],
    destinationCountry: lane.destination[2],
    equipmentType: randItem(EQUIPMENT_TYPES),
    weightLbs: randInt(20000, 44000),
    distanceMiles: lane.miles,
    pickupDate: pickupDateInDays(randInt(2, 5)),
    deliveryDate: pickupDateInDays(randInt(3, 7)),
    postedRate: Math.round(lane.miles * 2.8),
    postedRateCurrency: 'CAD',
    rateType: 'all_in',
    shipperCompany: `TEST_${randItem(SHIPPER_NAMES)}`,
    shipperContactName: randItem(CONTACT_NAMES),
    shipperPhone: fictionalPhone(),
    shipperEmail: `test_${idx}@example.test`,
  };
}

function generateEquipmentFailLoad(idx: number): RawLoadInput {
  const lane = randItem(GOOD_LANES);
  return {
    loadId: `TEST_EQUIPFAIL_${idx}`,
    loadBoardSource: 'manual',
    originCity: lane.origin[0],
    originState: lane.origin[1],
    originCountry: lane.origin[2],
    destinationCity: lane.destination[0],
    destinationState: lane.destination[1],
    destinationCountry: lane.destination[2],
    equipmentType: randItem(RARE_EQUIPMENT),
    weightLbs: randInt(20000, 44000),
    distanceMiles: lane.miles,
    pickupDate: pickupDateInDays(randInt(2, 5)),
    deliveryDate: pickupDateInDays(randInt(3, 7)),
    postedRate: Math.round(lane.miles * 2.8),
    postedRateCurrency: 'CAD',
    rateType: 'all_in',
    shipperCompany: `TEST_${randItem(SHIPPER_NAMES)}`,
    shipperContactName: randItem(CONTACT_NAMES),
    shipperPhone: fictionalPhone(),
    shipperEmail: `test_${idx}@example.test`,
  };
}

function generateFreshnessFailLoad(idx: number): RawLoadInput {
  const lane = randItem(GOOD_LANES);
  // Pickup either way in the past or > 30 days out
  const offsetDays = Math.random() < 0.5 ? -2 : 35;
  return {
    loadId: `TEST_FRESHFAIL_${idx}`,
    loadBoardSource: 'manual',
    originCity: lane.origin[0],
    originState: lane.origin[1],
    originCountry: lane.origin[2],
    destinationCity: lane.destination[0],
    destinationState: lane.destination[1],
    destinationCountry: lane.destination[2],
    equipmentType: randItem(EQUIPMENT_TYPES),
    weightLbs: randInt(20000, 44000),
    distanceMiles: lane.miles,
    pickupDate: pickupDateInDays(offsetDays),
    deliveryDate: pickupDateInDays(offsetDays + 1),
    postedRate: Math.round(lane.miles * 2.8),
    postedRateCurrency: 'CAD',
    rateType: 'all_in',
    shipperCompany: `TEST_${randItem(SHIPPER_NAMES)}`,
    shipperContactName: randItem(CONTACT_NAMES),
    shipperPhone: fictionalPhone(),
    shipperEmail: `test_${idx}@example.test`,
  };
}

function generateMix(count: number): RawLoadInput[] {
  // Target distribution
  const targetGood = Math.round(count * 0.25);
  const targetMargin = Math.round(count * 0.30);
  const targetLane = Math.round(count * 0.20);
  const targetEquipment = Math.round(count * 0.15);
  const targetFresh = count - targetGood - targetMargin - targetLane - targetEquipment;

  const out: RawLoadInput[] = [];
  for (let i = 0; i < targetGood; i++) out.push(generateGoodLoad(i));
  for (let i = 0; i < targetMargin; i++) out.push(generateMarginFailLoad(i));
  for (let i = 0; i < targetLane; i++) out.push(generateLaneFailLoad(i));
  for (let i = 0; i < targetEquipment; i++) out.push(generateEquipmentFailLoad(i));
  for (let i = 0; i < targetFresh; i++) out.push(generateFreshnessFailLoad(i));

  // Shuffle so the qualifier doesn't process them in family order
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseArgs(): { count: number; baseUrl: string } {
  const args = process.argv.slice(2);
  let count = 50;
  let baseUrl = process.env.SHADOW_BASE_URL || 'http://localhost:3000';
  for (const a of args) {
    if (a.startsWith('--count=')) count = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--base-url=')) baseUrl = a.split('=')[1];
  }
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    console.error('Invalid --count (must be 1..500)');
    process.exit(1);
  }
  return { count, baseUrl };
}

async function main(): Promise<void> {
  const { count, baseUrl } = parseArgs();
  const token = process.env.PIPELINE_IMPORT_TOKEN;
  if (!token) {
    console.error('PIPELINE_IMPORT_TOKEN not set in env');
    process.exit(1);
  }

  const loads = generateMix(count);
  console.log(`\n→ Generating ${loads.length} synthetic loads (target ~25% qualification rate)`);
  console.log(`   GOOD:        ${loads.filter((l) => l.loadId.startsWith('TEST_GOOD_')).length}`);
  console.log(`   MARGINFAIL:  ${loads.filter((l) => l.loadId.startsWith('TEST_MARGINFAIL_')).length}`);
  console.log(`   LANEFAIL:    ${loads.filter((l) => l.loadId.startsWith('TEST_LANEFAIL_')).length}`);
  console.log(`   EQUIPFAIL:   ${loads.filter((l) => l.loadId.startsWith('TEST_EQUIPFAIL_')).length}`);
  console.log(`   FRESHFAIL:   ${loads.filter((l) => l.loadId.startsWith('TEST_FRESHFAIL_')).length}`);

  console.log(`\n→ POST ${baseUrl}/api/pipeline/import (Bearer auth)`);
  const startedAt = Date.now();

  const res = await fetch(`${baseUrl}/api/pipeline/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ loads }),
  });

  const durationMs = Date.now() - startedAt;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text if not JSON */
  }

  if (!res.ok) {
    console.error(`\n✗ HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    process.exit(1);
  }

  console.log(`\n✓ Submitted in ${durationMs}ms`);
  console.log('  Server response:', body);
  console.log('\nNext: open 03-watch-pipeline.sql against Neon to monitor the drain.');
  console.log('After ~10 min: run 04-shadow-metrics.ts for PASS/FAIL.');
}

main().catch((err) => {
  console.error('Generator crashed:', err);
  process.exit(1);
});
