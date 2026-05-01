import type { RawLoad } from '@/lib/workers/scanner-worker';

export function mapTruckstopToRawLoad(_apiRow: unknown): RawLoad | null {
  // TODO when Truckstop credentials arrive — see lib/loadboards/dat/mapper.ts for the pattern.
  return null;
}
