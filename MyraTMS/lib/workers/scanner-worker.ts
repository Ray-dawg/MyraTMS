/**
 * AGENT 1 - SCANNER WORKER
 *
 * Scans load board APIs (DAT, 123Loadboard, Truckstop, etc.) on a schedule,
 * normalizes data into the unified RawLoad schema, deduplicates, and enqueues
 * to qualify-queue for Agent 2 to evaluate.
 *
 * Input: Scheduled cron trigger (every 5/15/30 minutes depending on time of day)
 * Output: Loads written to pipeline_loads table, enqueued to qualify-queue
 * Next Stage: qualified (when Agent 2 completes)
 *
 * This worker is unique - it's triggered by a cron endpoint, not by a BullMQ job.
 * See /api/cron/scan-loadboards/route.ts for the cron trigger.
 * This file shows the core scanner logic that the cron endpoint orchestrates.
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getCached, setCache } from '@/lib/redis';

/** Thin RedisCache shim wrapping the existing REST-client helpers */
class RedisCache {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_redisClient?: unknown) {}
  async get<T>(key: string): Promise<T | null> { return getCached<T>(key); }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> { return setCache(key, value, ttlSeconds); }
}

/**
 * RawLoad interface - unified schema for all load board sources
 * Maps source-specific data to a consistent format
 */
export interface RawLoad {
  // Source identification
  loadId: string; // Original load ID from source
  loadBoardSource: 'dat' | '123lb' | 'truckstop' | 'truckpath' | 'loadlink' | 'manual';
  sourceUrl: string | null; // Direct URL to the posting

  // Geography
  originCity: string;
  originState: string;
  originCountry: string; // 'CA' | 'US'
  originLat: number | null;
  originLng: number | null;
  destinationCity: string;
  destinationState: string;
  destinationCountry: string;
  destinationLat: number | null;
  destinationLng: number | null;

  // Load details
  equipmentType: string; // Normalized: 'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck'
  commodity: string | null;
  weightLbs: number | null;
  distanceMiles: number | null;

  // Dates
  pickupDate: string; // ISO date
  pickupTimeWindow: string | null;
  deliveryDate: string | null;
  deliveryTimeWindow: string | null;

  // Rate
  postedRate: number | null;
  postedRateCurrency: string; // 'USD' | 'CAD'
  rateType: string; // 'all_in' | 'per_mile' | 'per_km'

  // Shipper contact
  shipperCompany: string | null;
  shipperContactName: string | null;
  shipperPhone: string | null;
  shipperEmail: string | null;

  // Metadata
  postedAt: string; // When the load was first posted
  expiresAt: string | null;
  scannedAt: string; // When Agent 1 captured it
}

/**
 * Scanner service for Myra Agent 1
 * Handles load board polling, normalization, deduplication, and pipeline entry
 */
export class ScannerService {
  private redis: Redis;
  private qualifyQueue: Queue;
  private cache: RedisCache;

  constructor(redisClient: Redis, qualifyQueueRef: Queue) {
    this.redis = redisClient;
    this.qualifyQueue = qualifyQueueRef;
    this.cache = new RedisCache(redisClient);
  }

  /**
   * CSV / manual ingestion entrypoint. Used by `POST /api/pipeline/import`
   * and by future shadow-mode batch loaders. Validates, normalizes, dedupes
   * via the unique (load_id, load_board_source) key, inserts, and enqueues
   * to qualify-queue. Returns counts plus per-row errors so the caller can
   * display a results report.
   *
   * Loads board scraper integration (DAT / Truckstop / 123LB) is the
   * separate `scanAllSources` flow which is still TODO.
   */
  public async ingestRawLoads(
    rawLoads: Array<Partial<RawLoad>>,
    source: RawLoad['loadBoardSource'] = 'manual',
  ): Promise<{
    received: number;
    inserted: number;
    duplicates: number;
    invalid: number;
    errors: Array<{ index: number; error: string }>;
    insertedIds: number[];
  }> {
    const errors: Array<{ index: number; error: string }> = [];
    const valid: RawLoad[] = [];

    rawLoads.forEach((row, idx) => {
      const filled: RawLoad = {
        loadId: row.loadId ?? '',
        loadBoardSource: (row.loadBoardSource ?? source) as RawLoad['loadBoardSource'],
        sourceUrl: row.sourceUrl ?? null,
        originCity: row.originCity ?? '',
        originState: row.originState ?? '',
        originCountry: row.originCountry ?? 'US',
        originLat: row.originLat ?? null,
        originLng: row.originLng ?? null,
        destinationCity: row.destinationCity ?? '',
        destinationState: row.destinationState ?? '',
        destinationCountry: row.destinationCountry ?? 'US',
        destinationLat: row.destinationLat ?? null,
        destinationLng: row.destinationLng ?? null,
        equipmentType: this.normalizeEquipmentType(row.equipmentType ?? 'dry_van'),
        commodity: row.commodity ?? null,
        weightLbs: row.weightLbs ?? null,
        distanceMiles: row.distanceMiles ?? null,
        pickupDate: row.pickupDate ?? '',
        pickupTimeWindow: row.pickupTimeWindow ?? null,
        deliveryDate: row.deliveryDate ?? null,
        deliveryTimeWindow: row.deliveryTimeWindow ?? null,
        postedRate: row.postedRate ?? null,
        postedRateCurrency: row.postedRateCurrency ?? 'USD',
        rateType: row.rateType ?? 'all_in',
        shipperCompany: row.shipperCompany ?? null,
        shipperContactName: row.shipperContactName ?? null,
        shipperPhone: row.shipperPhone ?? null,
        shipperEmail: row.shipperEmail ?? null,
        postedAt: row.postedAt ?? new Date().toISOString(),
        expiresAt: row.expiresAt ?? null,
        scannedAt: new Date().toISOString(),
      };

      const validation = this.validateRawLoad(filled);
      if (validation) {
        errors.push({ index: idx, error: validation });
      } else {
        valid.push(filled);
      }
    });

    let inserted = 0;
    let duplicates = 0;
    const insertedIds: number[] = [];

    for (let i = 0; i < valid.length; i++) {
      const load = valid[i];
      try {
        const res = await db.query<{ id: number }>(
          `INSERT INTO pipeline_loads (
             load_id, load_board_source,
             origin_city, origin_state, origin_country,
             destination_city, destination_state, destination_country,
             pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
             distance_miles,
             shipper_company, shipper_contact_name, shipper_phone, shipper_email,
             posted_rate, posted_rate_currency, rate_type,
             stage, stage_updated_at, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21,
             'scanned', NOW(), 'scanner-csv-v1'
           )
           ON CONFLICT (load_id, load_board_source) DO NOTHING
           RETURNING id`,
          [
            load.loadId,
            load.loadBoardSource,
            load.originCity,
            load.originState,
            load.originCountry,
            load.destinationCity,
            load.destinationState,
            load.destinationCountry,
            load.pickupDate,
            load.deliveryDate,
            load.equipmentType,
            load.commodity,
            load.weightLbs,
            load.distanceMiles,
            load.shipperCompany,
            load.shipperContactName,
            load.shipperPhone,
            load.shipperEmail,
            load.postedRate,
            load.postedRateCurrency,
            load.rateType,
          ],
        );

        if (res.rows.length === 0) {
          duplicates++;
          continue;
        }

        const pipelineLoadId = res.rows[0].id;
        inserted++;
        insertedIds.push(pipelineLoadId);

        await this.qualifyQueue.add(
          'qualify',
          {
            pipelineLoadId,
            loadId: load.loadId,
            loadBoardSource: load.loadBoardSource,
            enqueuedAt: new Date().toISOString(),
            priority: load.postedRate ? Math.round(load.postedRate) : 0,
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
          },
          { priority: load.postedRate ? Math.round(load.postedRate) : 0 },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ index: i, error: `insert_failed: ${msg}` });
      }
    }

    logger.info(
      `[Scanner] CSV ingest from source=${source}: received=${rawLoads.length}, inserted=${inserted}, duplicates=${duplicates}, invalid=${errors.length}`,
    );

    return {
      received: rawLoads.length,
      inserted,
      duplicates,
      invalid: errors.length,
      errors,
      insertedIds,
    };
  }

  /**
   * Per-row validation. Returns null if valid, error message if not.
   */
  private validateRawLoad(load: RawLoad): string | null {
    if (!load.loadId) return 'missing loadId';
    if (!load.originCity || !load.originState) return 'missing origin city/state';
    if (!load.destinationCity || !load.destinationState) return 'missing destination city/state';
    if (!load.pickupDate) return 'missing pickupDate';
    if (load.originCountry && !['CA', 'US'].includes(load.originCountry)) {
      return `unsupported origin country: ${load.originCountry}`;
    }
    if (load.destinationCountry && !['CA', 'US'].includes(load.destinationCountry)) {
      return `unsupported destination country: ${load.destinationCountry}`;
    }
    return null;
  }

  /**
   * Main scanner orchestration - called by the cron endpoint
   * Returns: { totalScanned, totalNew, sources }
   */
  public async scanAllSources(): Promise<{ totalScanned: number; totalNew: number; sources: string[] }> {
    logger.info('[Scanner] Starting load board scan');
    const startTime = Date.now();

    const activeSources = this.getActiveSources(); // Get from config/env
    let totalScanned = 0;
    let totalNew = 0;

    for (const source of activeSources) {
      try {
        logger.debug(`[Scanner] Scanning source: ${source}`);

        // TODO: Fetch loads from source API
        // const loads = await fetchFromSource(source);
        // Implementation steps:
        // 1. Get API credentials from integrations
        // 2. Call source-specific API client
        // 3. Apply rate limiting and freshness filters
        // 4. Return array of raw API responses

        const loads: any[] = []; // Placeholder - implement fetchFromSource

        // Map each source-specific load to unified RawLoad schema
        const mapped: RawLoad[] = loads.map((raw) => this.mapLoadBySource(source, raw));
        totalScanned += mapped.length;

        // Deduplicate and write to pipeline_loads
        const { inserted, duplicates } = await this.writeToDatabase(mapped);
        totalNew += inserted.length;

        logger.info(
          `[Scanner] Source ${source}: scanned=${mapped.length}, new=${inserted.length}, dupes=${duplicates}`
        );

        // Enqueue new loads to qualify-queue for Agent 2
        for (const load of inserted) {
          const payload = this.buildQualifyPayload(load);
          await this.qualifyQueue.add('qualify', payload, {
            priority: load.postedRate ? Math.round(load.postedRate) : 0,
          });
        }

        // Update last scan timestamp in Redis (for freshness tracking)
        await this.cache.set(`scanner:last_scan:${source}`, new Date().toISOString(), 3600);
      } catch (error) {
        logger.error(`[Scanner] Error scanning source ${source}:`, error);
        // Continue with other sources - don't let one failure stop all
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      `[Scanner] Scan complete. Total scanned: ${totalScanned}, New: ${totalNew}, Duration: ${duration}ms`
    );

    return { totalScanned, totalNew, sources: activeSources };
  }

  /**
   * Map source-specific load data to unified RawLoad schema
   * Each load board API returns different field names - this normalizes them
   */
  private mapLoadBySource(source: string, raw: any): RawLoad {
    // TODO: Implement source-specific mapping logic
    // This is a placeholder showing the structure
    // In reality, each source (DAT, Truckstop, etc.) needs a dedicated mapper function

    // Example placeholder:
    const normalized: RawLoad = {
      loadId: raw.id || raw.matchId || 'unknown',
      loadBoardSource: source as any,
      sourceUrl: raw.url || null,
      originCity: raw.origin?.city || raw.originCity || '',
      originState: raw.origin?.state || raw.originState || '',
      originCountry: raw.origin?.country === 'CAN' ? 'CA' : 'US',
      originLat: raw.origin?.lat || null,
      originLng: raw.origin?.lng || null,
      destinationCity: raw.destination?.city || raw.destCity || '',
      destinationState: raw.destination?.state || raw.destState || '',
      destinationCountry: raw.destination?.country === 'CAN' ? 'CA' : 'US',
      destinationLat: raw.destination?.lat || null,
      destinationLng: raw.destination?.lng || null,
      equipmentType: this.normalizeEquipmentType(raw.equipment || raw.equipmentType || 'dry_van'),
      commodity: raw.commodity || null,
      weightLbs: raw.weight || raw.weightLbs || null,
      distanceMiles: raw.miles || raw.distanceMiles || null,
      pickupDate: raw.pickupDate || raw.pickup_date || '',
      pickupTimeWindow: raw.pickupTime || raw.pickup_time || null,
      deliveryDate: raw.deliveryDate || raw.delivery_date || null,
      deliveryTimeWindow: raw.deliveryTime || null,
      postedRate: raw.rate?.amount || raw.rate || null,
      postedRateCurrency: raw.rate?.currency || 'USD',
      rateType: 'all_in',
      shipperCompany: raw.shipper?.company || raw.shipperCompany || null,
      shipperContactName: raw.shipper?.contact || raw.shipperName || null,
      shipperPhone: raw.shipper?.phone || raw.shipperPhone || null,
      shipperEmail: raw.shipper?.email || raw.shipperEmail || null,
      postedAt: raw.postedAt || new Date().toISOString(),
      expiresAt: raw.expiresAt || null,
      scannedAt: new Date().toISOString(),
    };

    return normalized;
  }

  /**
   * Normalize equipment type strings across different sources
   */
  private normalizeEquipmentType(raw: string): string {
    const map: Record<string, string> = {
      V: 'dry_van',
      VAN: 'dry_van',
      'DRY VAN': 'dry_van',
      F: 'flatbed',
      FLAT: 'flatbed',
      FLATBED: 'flatbed',
      R: 'reefer',
      REEFER: 'reefer',
      REFRIGERATED: 'reefer',
      T: 'tanker',
      TANK: 'tanker',
      TANKER: 'tanker',
      SD: 'step_deck',
      'STEP DECK': 'step_deck',
    };

    return map[raw.toUpperCase()] || 'dry_van';
  }

  /**
   * Write normalized loads to pipeline_loads table
   * Handles deduplication (exact and cross-source)
   */
  private async writeToDatabase(
    loads: RawLoad[]
  ): Promise<{ inserted: RawLoad[]; duplicates: number }> {
    const inserted: RawLoad[] = [];
    let duplicates = 0;

    for (const load of loads) {
      try {
        // TODO: Implement deduplication and database write
        // Steps:
        // 1. Check for exact duplicate (same load_id + source)
        // 2. Check for cross-source duplicate (same shipper + origin + destination + date + equipment)
        // 3. If not duplicate, insert into pipeline_loads with stage='scanned'
        // 4. Return inserted load for queueing

        // Placeholder - implement actual DB logic:
        const result = await db.query(
          `INSERT INTO pipeline_loads (
            load_id, load_board_source,
            origin_city, origin_state, origin_country,
            destination_city, destination_state, destination_country,
            pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
            distance_miles,
            shipper_company, shipper_contact_name, shipper_phone, shipper_email,
            posted_rate, posted_rate_currency, rate_type,
            stage, stage_updated_at, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
          ON CONFLICT (load_id, load_board_source) DO UPDATE SET updated_at = NOW()
          RETURNING *`,
          [
            load.loadId,
            load.loadBoardSource,
            load.originCity,
            load.originState,
            load.originCountry,
            load.destinationCity,
            load.destinationState,
            load.destinationCountry,
            load.pickupDate,
            load.deliveryDate,
            load.equipmentType,
            load.commodity,
            load.weightLbs,
            load.distanceMiles,
            load.shipperCompany,
            load.shipperContactName,
            load.shipperPhone,
            load.shipperEmail,
            load.postedRate,
            load.postedRateCurrency,
            load.rateType,
            'scanned',
            new Date().toISOString(),
            'scanner-v1',
          ]
        );

        if (result.rows[0]) {
          inserted.push(load);
        }
      } catch (error) {
        if ((error as any).code === '23505') {
          // Unique constraint violation - duplicate
          duplicates++;
        } else {
          throw error;
        }
      }
    }

    return { inserted, duplicates };
  }

  /**
   * Build the QualifyJobPayload for enqueueing to qualify-queue
   */
  private buildQualifyPayload(load: RawLoad): any {
    // TODO: Build and return QualifyJobPayload
    // This payload will be received by Agent 2 (Qualifier)
    // Structure defined in T-03 Orchestration Backbone

    return {
      pipelineLoadId: 0, // Will be fetched from DB after insert
      loadId: load.loadId,
      loadBoardSource: load.loadBoardSource,
      enqueuedAt: new Date().toISOString(),
      priority: 0, // Will be set based on posted_rate

      // QualifyJobPayload fields
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
      distanceMiles: load.distanceMiles || 0,
      pickupDate: load.pickupDate,
      shipperPhone: load.shipperPhone,
    };
  }

  /**
   * Get list of active load board sources from config
   */
  private getActiveSources(): string[] {
    // TODO: Implement config lookup
    // Get from environment variables or settings table
    // Example: return ['dat', '123lb', 'truckstop']
    return [];
  }
}

// TODO: Implement source-specific API clients and mappers
// - fetchFromSource(source: string): Promise<any[]>
// - mapDATLoad(raw: any): RawLoad
// - map123LoadboardLoad(raw: any): RawLoad
// - mapTruckstopLoad(raw: any): RawLoad
// - mapTruckPathLoad(raw: any): RawLoad
// - mapLoadlinkLoad(raw: any): RawLoad

// TODO: Export initialized scanner service
// export const scannerService = new ScannerService(redisClient, qualifyQueue);
