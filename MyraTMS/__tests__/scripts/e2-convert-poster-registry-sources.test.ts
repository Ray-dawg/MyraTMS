/**
 * E2-01 Gate 1 — the converter's fail-closed collision rule.
 *
 * The seed is the ONLY path to a shipper_direct accept (FMCSA cannot establish
 * shipper-direct status — tracker entry 2026-10-08), so a company claimed by
 * two source lists must never land on the accepting class. 68 real companies
 * are in both a trucking list and a broker list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCandidates, resolve } from '@/scripts/e2_convert_poster_registry_sources';

let dir: string;
const w = (name: string, body: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
};

describe('e2_convert_poster_registry_sources', () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-conv-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gives a broker label precedence over a carrier label for the same company', () => {
    const carriers = w('c.csv', 'Company Name,City,Province,Country\nBison Transport,Winnipeg,MB,Canada\n');
    const fmcsa = w('f.csv', 'Legal Name,DBA / Operating Name,City,Province,Country,USDOT Number,MC Number,Broker Authority\nBison Transport,,Winnipeg,MB,Canada,100001,MC222222,Property Broker\n');
    const { candidates } = buildCandidates({ canadianCarriers: carriers, fmcsaBrokers: fmcsa });
    const { byOutput, droppedLowerPrecedence, precedenceOverrides } = resolve(candidates);
    expect(byOutput.get('carriers')).toHaveLength(0);
    expect(byOutput.get('fmcsaBrokers')).toHaveLength(1);
    expect(droppedLowerPrecedence).toBe(1);
    expect(precedenceOverrides[0]).toMatchObject({ normalized: 'bison transport', keptAs: 'broker-list-fmcsa.csv' });
  });

  it('gives a broker label precedence over a shipper label — a shipper row can never win a collision', () => {
    const mines = w('m.csv', 'Company Name\nAcme Mining Ltd.\n');
    const brokers = w('b.csv', 'Company,HQ City,Province/State,Country\nAcme Mining Inc.,Toronto,ON,Canada\n');
    const { candidates } = buildCandidates({ mines, brokers });
    const { byOutput } = resolve(candidates);
    // 'acme mining' after normalizeCompanyName strips both Ltd. and Inc.
    expect(byOutput.get('mines')).toHaveLength(0);
    expect(byOutput.get('brokers')).toHaveLength(1);
  });

  it('normalizes MC/DOT to digits so a registry row matches poster_mc_number from ingest', () => {
    const fmcsa = w('f2.csv', 'Legal Name,DBA / Operating Name,City,Province,Country,USDOT Number,MC Number,Broker Authority\nContinental Cartage,,Acheson,AB,Canada,747494,MC339087,Property Broker\n');
    const { candidates } = buildCandidates({ fmcsaBrokers: fmcsa });
    const { byOutput } = resolve(candidates);
    expect(byOutput.get('fmcsaBrokers')![0]).toMatchObject({ mc_number: '339087', dot_number: '747494', country: 'CA' });
  });

  it('emits a differing DBA as its own name row, without duplicating the MC onto it', () => {
    const fmcsa = w('f3.csv', 'Legal Name,DBA / Operating Name,City,Province,Country,USDOT Number,MC Number,Broker Authority\n689803 Alberta Ltd,Continental Cartage,Acheson,AB,Canada,747494,MC339087,Property Broker\n');
    const { candidates } = buildCandidates({ fmcsaBrokers: fmcsa });
    const rows = resolve(candidates).byOutput.get('fmcsaBrokers')!;
    expect(rows).toHaveLength(2);
    const dba = rows.find((r) => r.legal_name === 'Continental Cartage')!;
    const legal = rows.find((r) => r.legal_name === '689803 Alberta Ltd')!;
    expect(legal.mc_number).toBe('339087');
    // poster_registry has a unique index on mc_number — only one row may carry it.
    expect(dba.mc_number).toBe('');
  });

  it('collapses a within-class duplicate and keeps the row that carries an identity number', () => {
    const fmcsa = w('f4.csv', [
      'Legal Name,DBA / Operating Name,City,Province,Country,USDOT Number,MC Number,Broker Authority',
      'Dup Freight Ltd,,Toronto,ON,Canada,,,Property Broker',
      'Dup Freight Limited,,Toronto,ON,Canada,555001,MC555002,Property Broker',
    ].join('\n') + '\n');
    const { candidates } = buildCandidates({ fmcsaBrokers: fmcsa });
    const { byOutput, droppedDuplicateWithinClass } = resolve(candidates);
    const rows = byOutput.get('fmcsaBrokers')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].mc_number).toBe('555002');
    expect(droppedDuplicateWithinClass).toBe(1);
  });
});
