// lib/contract-intake/finalize-booking.ts
//
// T-30 §5/§10 step 6 — the ONE new piece of pipeline orchestration this
// module adds, deliberately kept outside qualifier-worker.ts/researcher-worker.ts/
// ranker-worker.ts (acceptance criterion 7). Everything upstream of `matched`
// is the real Researcher/Ranker workers running completely unmodified against
// the row Task 9's approval action inserted — this poller only finishes the
// booking once they've done their normal work.
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

interface MatchedTender {
  id: number;
  posted_rate: string | null;
  market_rate_floor: string | null;
}

// profit_margin_pct is DECIMAL(5,2): anything outside ±999.99 overflows the column.
const MARGIN_PCT_LIMIT = 999.99;

export async function finalizeMatchedTenders(): Promise<{ finalized: number; skipped: number }> {
  const { rows } = await db.query<MatchedTender>(
    `SELECT id, posted_rate, market_rate_floor
       FROM pipeline_loads
      WHERE stage = 'matched' AND source_type = 'email_tender'`,
  );

  let finalized = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      const agreedRate = Number(row.posted_rate);
      // A tender without a usable posted rate must not book at $0; leave it
      // 'matched' for a human to resolve.
      if (!Number.isFinite(agreedRate) || agreedRate <= 0) {
        logger.warn(`[finalize-booking] skipping pipeline_load ${row.id}`, {
          loadId: row.id,
          reason: 'missing_posted_rate',
        });
        skipped++;
        continue;
      }
      // Cost proxy: market_rate_floor is the Researcher's own cost estimate
      // for this lane (lib/workers/researcher-worker.ts populates it before
      // 'matched' is ever reached) — the same field the real AI-call booking
      // path already treats as the cost baseline for profit math.
      const costProxy = row.market_rate_floor !== null ? Number(row.market_rate_floor) : agreedRate;
      const profit = agreedRate - costProxy;
      const rawMarginPct = (profit / agreedRate) * 100;
      const profitMarginPct = Math.round(
        Math.min(MARGIN_PCT_LIMIT, Math.max(-MARGIN_PCT_LIMIT, rawMarginPct)) * 100,
      ) / 100;

      const updated = await db.query<{ id: number }>(
        `UPDATE pipeline_loads
            SET stage = 'booked', booked_at = NOW(), booked_via = 'email_tender',
                agreed_rate = $1, agreed_rate_currency = posted_rate_currency,
                profit = $2, profit_margin_pct = $3,
                stage_updated_at = NOW(), updated_at = NOW()
          WHERE id = $4 AND stage = 'matched'
          RETURNING id`,
        [agreedRate, profit, profitMarginPct, row.id],
      );
      // A lost race (row already moved off 'matched') updates nothing; only
      // count rows this call actually booked.
      if (updated.rows.length > 0) finalized++;
      // inbound_emails.created_pipeline_load_id is written only by Task 9's
      // approval branch (sole writer); this poller does not backfill it.
    } catch (err) {
      logger.error(`[finalize-booking] failed to finalize pipeline_load ${row.id}`, err);
    }
  }
  return { finalized, skipped };
}
