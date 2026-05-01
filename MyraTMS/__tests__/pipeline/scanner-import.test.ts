/**
 * Scanner CSV import integration test.
 *
 * Tests the ScannerService.ingestRawLoads() ingestion path against live
 * Neon + live Upstash. The HTTP route layer (auth/kill-switch/JSON parsing)
 * is thin and tested implicitly — this exercises the data path:
 *   - Valid loads are inserted with stage='scanned'
 *   - Duplicates (same load_id + source) are detected
 *   - Invalid loads are reported in errors[] without aborting the batch
 *   - Inserted loads land on the qualify-queue with the right priority
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { ScannerService, type RawLoad } from '@/lib/workers/scanner-worker';

const RUN_ID = `TEST-SC-${Date.now()}`;

describe('ScannerService.ingestRawLoads', () => {
  let queue: Queue;
  let service: ScannerService;
  const insertedIds: number[] = [];

  beforeAll(() => {
    // Use a dedicated test queue name so we don't pollute the real qualify-queue.
    queue = new Queue('qualify-queue-test-import', { connection: redisConnection });
    service = new ScannerService(redisConnection, queue);
  });

  afterAll(async () => {
    if (insertedIds.length) {
      await db.query(
        `DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`,
        [insertedIds],
      );
    }
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('ingests a mixed batch — valid, invalid, duplicate', async () => {
    const validLoads: Array<Partial<RawLoad>> = [
      {
        loadId: `${RUN_ID}-A`,
        loadBoardSource: 'manual',
        originCity: 'Toronto',
        originState: 'ON',
        originCountry: 'CA',
        destinationCity: 'Sudbury',
        destinationState: 'ON',
        destinationCountry: 'CA',
        equipmentType: 'Dry Van',
        pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
        postedRate: 2400,
        postedRateCurrency: 'CAD',
        distanceMiles: 250,
      },
      {
        loadId: `${RUN_ID}-B`,
        loadBoardSource: 'manual',
        originCity: 'Chicago',
        originState: 'IL',
        originCountry: 'US',
        destinationCity: 'Dallas',
        destinationState: 'TX',
        destinationCountry: 'US',
        equipmentType: 'reefer',
        pickupDate: new Date(Date.now() + 4 * 86400_000).toISOString(),
        postedRate: 3100,
        postedRateCurrency: 'USD',
        distanceMiles: 920,
      },
    ];

    const invalidLoad: Partial<RawLoad> = {
      // Missing loadId on purpose
      loadBoardSource: 'manual',
      originCity: 'Atlanta',
      originState: 'GA',
      destinationCity: 'Miami',
      destinationState: 'FL',
      pickupDate: new Date().toISOString(),
    };

    const first = await service.ingestRawLoads(
      [validLoads[0], invalidLoad, validLoads[1]],
      'manual',
    );
    insertedIds.push(...first.insertedIds);

    expect(first.received).toBe(3);
    expect(first.inserted).toBe(2);
    expect(first.invalid).toBe(1);
    expect(first.duplicates).toBe(0);
    expect(first.errors[0].error).toMatch(/missing loadId/);

    // Re-submit the same batch — both valid loads are now duplicates.
    const second = await service.ingestRawLoads(validLoads, 'manual');
    expect(second.received).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);

    // Verify rows landed in pipeline_loads with stage='scanned'.
    const stages = await db.query<{ stage: string; load_id: string }>(
      `SELECT stage, load_id FROM pipeline_loads WHERE load_id = ANY($1::text[])`,
      [[validLoads[0].loadId, validLoads[1].loadId]],
    );
    expect(stages.rows.length).toBe(2);
    for (const row of stages.rows) {
      expect(row.stage).toBe('scanned');
    }

    // Verify both inserted loads landed on the qualify-queue with priority
    // matching their posted rates.
    const jobs = await queue.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const ourJobs = jobs.filter((j) =>
      [validLoads[0].loadId, validLoads[1].loadId].includes(j.data?.loadId),
    );
    expect(ourJobs.length).toBe(2);
    const priorities = ourJobs.map((j) => j.opts.priority).sort();
    expect(priorities).toEqual([2400, 3100]);
  }, 30_000);
});
