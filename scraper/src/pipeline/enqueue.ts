/**
 * qualify-queue enqueue.
 *
 * Payload shape MUST match what MyraTMS/lib/workers/scanner-worker.ts
 * produces, so the existing Qualifier worker (Engine 2) consumes scraped
 * jobs identically to API/CSV ones. Field-for-field equivalence verified
 * against `scanner-worker.ts:222-247`.
 */

import type { Queue } from 'bullmq';
import type { RawLoad } from './normalize.js';

export interface QualifyJobPayload {
  pipelineLoadId: number;
  loadId: string;
  loadBoardSource: string;
  enqueuedAt: string;
  priority: number;
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  equipmentType: string;
  postedRate: number | null;
  postedRateCurrency: string;
  distanceMiles: number;
  pickupDate: string;
  shipperPhone: string | null;
}

export function buildQualifyPayload(load: RawLoad, pipelineLoadId: number): QualifyJobPayload {
  const priority = load.postedRate ? Math.round(load.postedRate) : 0;
  return {
    pipelineLoadId,
    loadId: load.loadId,
    loadBoardSource: load.loadBoardSource,
    enqueuedAt: new Date().toISOString(),
    priority,
    origin: {
      city: load.originCity,
      state: load.originState,
      country: load.originCountry,
    },
    destination: {
      city: load.destinationCity,
      state: load.destinationState,
      country: load.destinationCountry,
    },
    equipmentType: load.equipmentType,
    postedRate: load.postedRate,
    postedRateCurrency: load.postedRateCurrency,
    distanceMiles: load.distanceMiles ?? 0,
    pickupDate: load.pickupDate,
    shipperPhone: load.shipperPhone,
  };
}

export async function enqueueQualify(queue: Queue, payload: QualifyJobPayload): Promise<void> {
  await queue.add('qualify', payload, {
    priority: payload.priority,
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  });
}
