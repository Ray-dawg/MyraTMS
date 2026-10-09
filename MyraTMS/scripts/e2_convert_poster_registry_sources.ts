/**
 * E2-01 Gate 1 — converts the operator's raw lead/broker/carrier lists into the
 * normalized seed CSVs `e2_seed_poster_registry.ts` reads, and prints a
 * manifest so PRD §4.13 criterion 5 ("seed counts match the manifest") can be
 * checked against something reproducible rather than a hand count.
 *
 * Usage (paths are the operator's raw files, which live outside the repo):
 *   pnpm tsx --env-file=.env.local scripts/e2_convert_poster_registry_sources.ts \
 *     --shippers=<pilot1_shippers.csv> \
 *     --mines=<ontario_mines.csv> \
 *     --ontario-carriers=<ontario_trucking_contacts.csv> \
 *     --canadian-carriers=<canadian_trucking_contacts.csv> \
 *     --brokers=<freight_brokers_canada.csv> \
 *     --fmcsa-brokers=<canada_freight_brokers_fmcsa.csv> \
 *     [--out=scripts/data/poster-registry-seed] [--manifest=<path.json>]
 *
 * Why a committed script and not a one-off: the seed is now the ONLY path to a
 * shipper_direct accept (FMCSA cannot establish shipper-direct status — see the
 * tracker entry dated 2026-10-08), so how a raw row became a registry class is
 * audit-relevant and has to be re-runnable.
 */
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { normalizeCompanyName } from '@/lib/pipeline/load-source-classifier';
import { normalizeIdNumber } from '@/lib/pipeline/poster-identity';

/**
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION TABLE — the one place operator judgment is encoded.
 *
 * `precedence` resolves a company that appears in more than one source list.
 * Higher wins. The ordering is fail-closed on purpose: in the shipper-direct
 * gate, `broker` rejects, `carrier_for_hire` goes to human review, and
 * `shipper` ACCEPTS. A wrong accept is the double-brokering exposure this
 * whole gate exists to prevent, so a name claimed by two lists must never
 * land on the accepting class.
 *
 * This matters concretely: 68 companies appear in BOTH a trucking list and a
 * broker list (Bison Transport, Charger Logistics, CSA Transportation, ...).
 * That is not dirty data — it is the same finding the live FMCSA runs produced
 * on 2026-10-08, where carriers and even shippers routinely also hold broker
 * authority. All 1,264 FMCSA rows carry active Property Broker authority, so
 * for those 68 the broker label is the authoritative one.
 * ---------------------------------------------------------------------------
 */
const CLASSIFICATION = {
  broker: { precedence: 3, entityClass: 'broker' },
  carrier_for_hire: { precedence: 2, entityClass: 'carrier_for_hire' },
  shipper: { precedence: 1, entityClass: 'shipper' },
} as const;

type SourceKey = keyof typeof CLASSIFICATION;

interface OutputSpec {
  file: string;
  kind: SourceKey;
  /** Mirrors the class_source/confidence `e2_seed_poster_registry.ts` applies. */
  classSource: string;
  confidence: number;
}

const OUTPUTS = {
  shippers: { file: 'pilot1-shippers.csv', kind: 'shipper', classSource: 'seed_shipper_list', confidence: 0.9 },
  mines: { file: 'ontario-mines.csv', kind: 'shipper', classSource: 'seed_mines_dossier', confidence: 0.95 },
  brokers: { file: 'broker-list.csv', kind: 'broker', classSource: 'seed_broker_list', confidence: 0.9 },
  fmcsaBrokers: { file: 'broker-list-fmcsa.csv', kind: 'broker', classSource: 'seed_broker_list_fmcsa', confidence: 0.95 },
  carriers: { file: 'carriers-for-hire.csv', kind: 'carrier_for_hire', classSource: 'seed_carrier_list', confidence: 0.9 },
} satisfies Record<string, OutputSpec>;

type OutputKey = keyof typeof OUTPUTS;

interface SeedRow {
  legal_name: string;
  mc_number: string;
  dot_number: string;
  country: string;
  province_state: string;
}

interface Candidate extends SeedRow {
  normalized: string;
  outputKey: OutputKey;
  precedence: number;
  origin: string;
}

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

/** 'Canada' / 'CA' / 'CAN' maps to 'CA'; 'United States' / 'US' / 'USA' maps to 'US'. */
function normalizeCountry(raw: string | undefined): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'CA';
  if (v.startsWith('can') || v === 'ca') return 'CA';
  if (v.startsWith('u')) return 'US';
  return 'CA';
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function candidate(
  outputKey: OutputKey,
  origin: string,
  legalName: string,
  opts: { mc?: string; dot?: string; country?: string; province?: string } = {},
): Candidate | null {
  const legal = legalName.trim();
  if (!legal) return null;
  const normalized = normalizeCompanyName(legal);
  if (!normalized) return null;
  const spec = OUTPUTS[outputKey];
  return {
    legal_name: legal,
    mc_number: normalizeIdNumber(opts.mc ?? null) ?? '',
    dot_number: normalizeIdNumber(opts.dot ?? null) ?? '',
    country: normalizeCountry(opts.country),
    province_state: (opts.province ?? '').trim(),
    normalized,
    outputKey,
    precedence: CLASSIFICATION[spec.kind].precedence,
    origin,
  };
}

export interface ConvertManifest {
  generatedAt: string;
  inputs: Record<string, { file: string; rows: number }>;
  outputs: Array<{ file: string; entityClass: string; classSource: string; confidence: number; rows: number }>;
  totals: { candidates: number; written: number; droppedDuplicateWithinClass: number; droppedLowerPrecedence: number };
  /** Every name a higher-precedence list claimed away from a lower one — the audit trail for criterion 5. */
  precedenceOverrides: Array<{ normalized: string; keptAs: string; droppedFrom: string[] }>;
}

export interface ConvertInputs {
  shippers?: string;
  mines?: string;
  ontarioCarriers?: string;
  canadianCarriers?: string;
  brokers?: string;
  fmcsaBrokers?: string;
}

export function buildCandidates(files: ConvertInputs): { candidates: Candidate[]; inputs: ConvertManifest['inputs'] } {
  const candidates: Candidate[] = [];
  const inputs: ConvertManifest['inputs'] = {};

  if (files.shippers) {
    const rows = readCsv(files.shippers);
    inputs.shippers = { file: files.shippers, rows: rows.length };
    for (const r of rows) {
      const legal = pick(r, 'Company', 'Company Name', 'Legal Name');
      const operating = pick(r, 'Operating Name', 'DBA / Operating Name');
      const dot = pick(r, 'USDOT Number', 'DOT Number');
      const legalRow = candidate('shippers', 'pilot1-shipper-list', legal, {
        dot,
        country: pick(r, 'Country'),
        province: pick(r, 'Province', 'Province/State'),
      });
      if (legalRow) candidates.push(legalRow);
      // Same rule as the FMCSA DBA rows: emit a differing operating name so a
      // poster typing it still matches, but leave the DOT on the legal row --
      // poster_registry has a unique partial index on dot_number as well as
      // mc_number (migration 040), so duplicating it would fail the insert.
      if (operating && normalizeCompanyName(operating) !== normalizeCompanyName(legal)) {
        const opRow = candidate('shippers', 'pilot1-shipper-list-operating-name', operating, {
          country: pick(r, 'Country'),
          province: pick(r, 'Province', 'Province/State'),
        });
        if (opRow) candidates.push(opRow);
      }
    }
  }

  if (files.mines) {
    const rows = readCsv(files.mines);
    inputs.mines = { file: files.mines, rows: rows.length };
    for (const r of rows) {
      // The mines dossier has no MC/DOT (normal for Canadian domestic-only
      // shippers, PRD section 0.3.1) and every entry is an Ontario mine site.
      const c = candidate('mines', 'ontario-mines-dossier', pick(r, 'Company Name', 'Company'), {
        country: 'CA',
        province: 'ON',
      });
      if (c) candidates.push(c);
    }
  }

  const carrierFiles: Array<[string, string | undefined]> = [
    ['ontarioCarriers', files.ontarioCarriers],
    ['canadianCarriers', files.canadianCarriers],
  ];
  for (const [key, file] of carrierFiles) {
    if (!file) continue;
    const rows = readCsv(file);
    inputs[key] = { file, rows: rows.length };
    for (const r of rows) {
      const c = candidate('carriers', key, pick(r, 'Company Name', 'Company'), {
        country: pick(r, 'Country'),
        province: pick(r, 'Province', 'Province/State'),
      });
      if (c) candidates.push(c);
    }
  }

  if (files.brokers) {
    const rows = readCsv(files.brokers);
    inputs.brokers = { file: files.brokers, rows: rows.length };
    for (const r of rows) {
      const c = candidate('brokers', 'freight-brokers-canada', pick(r, 'Company', 'Company Name'), {
        country: pick(r, 'Country'),
        province: pick(r, 'Province/State', 'Province'),
      });
      if (c) candidates.push(c);
    }
  }

  if (files.fmcsaBrokers) {
    const rows = readCsv(files.fmcsaBrokers);
    inputs.fmcsaBrokers = { file: files.fmcsaBrokers, rows: rows.length };
    for (const r of rows) {
      const legal = pick(r, 'Legal Name');
      const dba = pick(r, 'DBA / Operating Name');
      const common = {
        mc: pick(r, 'MC Number'),
        dot: pick(r, 'USDOT Number'),
        country: pick(r, 'Country'),
        province: pick(r, 'Province'),
      };
      // Emit the DBA as its own row when it differs from the legal name: a load
      // board shows whichever name the poster typed, and findRegistryHit()
      // matches on exactly one normalized string. The MC/DOT ride on the legal
      // row only — duplicating them would collide with poster_registry's unique
      // MC index and make the seed script's existing-row probe ambiguous.
      const legalRow = candidate('fmcsaBrokers', 'fmcsa-broker-registry', legal, common);
      if (legalRow) candidates.push(legalRow);
      if (dba && normalizeCompanyName(dba) !== normalizeCompanyName(legal)) {
        const dbaRow = candidate('fmcsaBrokers', 'fmcsa-broker-registry-dba', dba, {
          country: common.country,
          province: common.province,
        });
        if (dbaRow) candidates.push(dbaRow);
      }
    }
  }

  return { candidates, inputs };
}

export function resolve(candidates: Candidate[]): {
  byOutput: Map<OutputKey, SeedRow[]>;
  droppedDuplicateWithinClass: number;
  droppedLowerPrecedence: number;
  precedenceOverrides: ConvertManifest['precedenceOverrides'];
} {
  // One winner per normalized name across ALL classes. Resolving collisions
  // here rather than leaning on the seed script's confidence tie-break makes
  // the manifest counts exact and the fail-closed rule explicit and testable.
  const winner = new Map<string, Candidate>();
  const losers = new Map<string, Set<string>>();
  let droppedDuplicateWithinClass = 0;
  let droppedLowerPrecedence = 0;

  for (const c of candidates) {
    const held = winner.get(c.normalized);
    if (!held) {
      winner.set(c.normalized, c);
      continue;
    }
    if (c.precedence > held.precedence) {
      winner.set(c.normalized, c);
      droppedLowerPrecedence += 1;
      if (!losers.has(c.normalized)) losers.set(c.normalized, new Set());
      losers.get(c.normalized)!.add(OUTPUTS[held.outputKey].file);
    } else if (c.precedence < held.precedence) {
      droppedLowerPrecedence += 1;
      if (!losers.has(c.normalized)) losers.set(c.normalized, new Set());
      losers.get(c.normalized)!.add(OUTPUTS[c.outputKey].file);
    } else {
      // Same class, same name. Keep whichever row carries an MC/DOT, since
      // identity numbers match ahead of names in findRegistryHit().
      if (!held.mc_number && !held.dot_number && (c.mc_number || c.dot_number)) winner.set(c.normalized, c);
      droppedDuplicateWithinClass += 1;
    }
  }

  const byOutput = new Map<OutputKey, SeedRow[]>();
  for (const key of Object.keys(OUTPUTS) as OutputKey[]) byOutput.set(key, []);
  for (const c of winner.values()) {
    byOutput.get(c.outputKey)!.push({
      legal_name: c.legal_name,
      mc_number: c.mc_number,
      dot_number: c.dot_number,
      country: c.country,
      province_state: c.province_state,
    });
  }
  for (const rows of byOutput.values()) rows.sort((a, b) => a.legal_name.localeCompare(b.legal_name));

  const precedenceOverrides = [...losers.entries()]
    .map(([normalized, files]) => ({
      normalized,
      keptAs: OUTPUTS[winner.get(normalized)!.outputKey].file,
      droppedFrom: [...files].sort(),
    }))
    .sort((a, b) => a.normalized.localeCompare(b.normalized));

  return { byOutput, droppedDuplicateWithinClass, droppedLowerPrecedence, precedenceOverrides };
}

function arg(name: string): string | undefined {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function main() {
  const outDir = arg('out') ?? path.join(process.cwd(), 'scripts', 'data', 'poster-registry-seed');
  const files: ConvertInputs = {
    shippers: arg('shippers'),
    mines: arg('mines'),
    ontarioCarriers: arg('ontario-carriers'),
    canadianCarriers: arg('canadian-carriers'),
    brokers: arg('brokers'),
    fmcsaBrokers: arg('fmcsa-brokers'),
  };
  if (!Object.values(files).some(Boolean)) {
    console.error('No input files given. See the usage block at the top of this file.');
    process.exit(2);
  }

  const { candidates, inputs } = buildCandidates(files);
  const { byOutput, droppedDuplicateWithinClass, droppedLowerPrecedence, precedenceOverrides } = resolve(candidates);

  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  const outputs: ConvertManifest['outputs'] = [];
  for (const key of Object.keys(OUTPUTS) as OutputKey[]) {
    const spec = OUTPUTS[key];
    const rows = byOutput.get(key) ?? [];
    const csv = Papa.unparse(rows, { columns: ['legal_name', 'mc_number', 'dot_number', 'country', 'province_state'] });
    fs.writeFileSync(path.join(outDir, spec.file), csv + '\n', 'utf8');
    written += rows.length;
    outputs.push({
      file: spec.file,
      entityClass: CLASSIFICATION[spec.kind].entityClass,
      classSource: spec.classSource,
      confidence: spec.confidence,
      rows: rows.length,
    });
  }

  const manifest: ConvertManifest = {
    generatedAt: new Date().toISOString(),
    inputs,
    outputs,
    totals: { candidates: candidates.length, written, droppedDuplicateWithinClass, droppedLowerPrecedence },
    precedenceOverrides,
  };
  const manifestPath = arg('manifest') ?? path.join(outDir, 'MANIFEST.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({
    inputs: manifest.inputs,
    outputs: manifest.outputs,
    totals: manifest.totals,
    precedenceOverrideCount: precedenceOverrides.length,
    manifestPath,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Convert failed:', err);
    process.exit(1);
  });
}
