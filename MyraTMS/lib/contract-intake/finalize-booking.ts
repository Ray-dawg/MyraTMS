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
  posted_rate: string;
  market_rate_floor: string | null;
}

export async function finalizeMatchedTenders(): Promise<{ finalized: number }> {
  const { rows } = await db.query<MatchedTender>(
    `SELECT id, posted_rate, market_rate_floor
       FROM pipeline_loads
      WHERE stage = 'matched' AND source_type = 'email_tender'`,
  );

  let finalized = 0;
  for (const row of rows) {
    try {
      const agreedRate = Number(row.posted_rate);
      // Cost proxy: market_rate_floor is the Researcher's own cost estimate
      // for this lane (lib/workers/researcher-worker.ts populates it before
      // 'matched' is ever reached) — the same field the real AI-call booking
      // path already treats as the cost baseline for profit math.
      const costProxy = row.market_rate_floor !== null ? Number(row.market_rate_floor) : agreedRate;
      const profit = agreedRate - costProxy;
      const profitMarginPct = agreedRate > 0 ? (profit / agreedRate) * 100 : 0;

      await db.query(
        `UPDATE pipeline_loads
            SET stage = 'booked', booked_at = NOW(), booked_via = 'email_tender',
                agreed_rate = $1, agreed_rate_currency = posted_rate_currency,
                profit = $2, profit_margin_pct = $3,
                stage_updated_at = NOW(), updated_at = NOW()
          WHERE id = $4 AND stage = 'matched'`,
        [agreedRate, profit, profitMarginPct, row.id],
      );
      // inbound_emails.created_pipeline_load_id is written only by Task 9's
      // approval branch (sole writer); this poller does not backfill it.
      finalized++;
    } catch (err) {
      logger.error(`[finalize-booking] failed to finalize pipeline_load ${row.id}`, err);
    }
  }
  return { finalized };
}
