/**
 * Quote feedback loop — records actual carrier costs and updates correction factors.
 * Called when a load tied to a quote is delivered.
 */

import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"

/**
 * Record a delivered load's real carrier cost against the quote that priced it
 * and fold that observation into the lane's correction factor.
 *
 * IDEMPOTENCY: updateCorrectionFactor() does `sample_size = sample_size + 1`
 * with a re-weighted correction_factor, so calling it twice for the same load
 * permanently double-counts it and skews the quoting engine. Every caller is a
 * `-> Delivered` status change, and `Delivered` is re-enterable: the load
 * detail page's manual status control offers the Invoiced -> Delivered ops
 * correction, so Invoiced -> Delivered -> Invoiced -> Delivered is one click
 * each way. `quotes.actual_carrier_cost` (set by the first run, and the only
 * place this fact is stored -- `loads` has no such column) is therefore used
 * as the exactly-once sentinel for the sample.
 *
 * The `quotes` UPDATE itself still re-runs: it is a plain SET, so refreshing
 * actual_carrier_cost / quote_accuracy / load_id is harmless and keeps the
 * quote accurate if the carrier cost was genuinely corrected. Only the
 * non-idempotent half is skipped.
 *
 * CONCURRENCY: the sentinel read is `SELECT ... FOR UPDATE`, not a bare
 * SELECT. withTenant() runs a real READ COMMITTED transaction (BEGIN /
 * set_config / COMMIT on one pooled WebSocket client -- lib/db/tenant-context.ts),
 * so the row lock is held until COMMIT. Without it, two runs racing for the
 * same quote both read NULL and both sample. The race is reachable: every
 * caller fires this UNAWAITED after its own `loads` transaction has already
 * committed and dropped its `FOR UPDATE` on the load row (see the call site in
 * app/api/loads/[id]/route.ts), so the load lock does not serialize us; a
 * retrying API client or a script re-delivering twice is enough.
 *
 * Lock order inside this transaction is always
 *   quotes (FOR UPDATE) -> loads (FOR KEY SHARE, via the load_id FK in the
 *   UPDATE below) -> quote_corrections (ON CONFLICT row lock)
 * and nothing takes them in the opposite order, so this cannot deadlock:
 *   - Another processQuoteFeedback on the same quote blocks on the first lock
 *     and then finds the sentinel set, so it never reaches quote_corrections.
 *   - PATCH /api/loads/[id] locks `loads` but never touches `quotes` in the
 *     same transaction.
 *   - POST /api/quotes/[id]/book is the only writer that touches both: it
 *     INSERTs a BRAND NEW `loads` row (a tuple no other transaction can hold a
 *     lock on) and only then UPDATEs `quotes`, so it never waits on `loads`
 *     while holding `quotes` -- the cycle has no second edge.
 *   - PATCH /api/quotes/[id] and PATCH /api/quotes/[id]/feedback touch
 *     `quotes` only.
 */
export async function processQuoteFeedback(
  tenantId: number,
  quoteId: string,
  actualCarrierCost: number,
  loadId: string,
) {
  await withTenant(tenantId, async (client) => {
    const { rows: quoteRows } = await client.query(
      // FOR UPDATE: serializes concurrent runs for the same quote so the
      // second one re-reads the sentinel the first one set. See the
      // CONCURRENCY note above for why the caller's load lock is not enough.
      `SELECT * FROM quotes WHERE id = $1 FOR UPDATE`,
      [quoteId],
    )
    const quote = quoteRows[0]
    if (!quote) return

    // Read BEFORE the UPDATE below sets it.
    const alreadySampled = quote.actual_carrier_cost != null

    const accuracy = 1 - Math.abs(Number(quote.carrier_cost_estimate) - actualCarrierCost) / actualCarrierCost

    await client.query(
      `UPDATE quotes
          SET actual_carrier_cost = $1,
              quote_accuracy = $2,
              load_id = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [actualCarrierCost, accuracy, loadId, quoteId],
    )

    if (alreadySampled) {
      // The sample in quote_corrections was taken from the FIRST cost and
      // cannot be un-weighted, so when the re-delivery reports a different
      // cost the quote row and the lane correction now disagree permanently.
      // That is a data-quality fact an operator may need, so it is logged at
      // error level with both numbers -- the equal-cost case (a plain
      // re-delivery, nothing repudiated) stays a warning.
      const recordedCost = Number(quote.actual_carrier_cost)
      if (recordedCost !== actualCarrierCost) {
        console.error(
          `[quote-feedback] quote ${quoteId} cost repudiated: recorded ${recordedCost}, now ${actualCarrierCost} (load ${loadId}). ` +
            `quotes.actual_carrier_cost/quote_accuracy were refreshed, but quote_corrections keeps the sample taken from ${recordedCost} ` +
            `-- the lane correction factor cannot be re-weighted and is now based on a repudiated cost.`,
        )
      } else {
        console.warn(
          `[quote-feedback] quote ${quoteId} already has actual_carrier_cost ${recordedCost}; refreshed the quote but skipped the quote_corrections sample (load ${loadId})`,
        )
      }
      return
    }

    await updateCorrectionFactor(
      client,
      quote.rate_source,
      quote.origin_region,
      quote.dest_region,
      quote.equipment_type,
      Number(quote.carrier_cost_estimate),
      actualCarrierCost,
    )
  })
}

async function updateCorrectionFactor(
  client: PoolClient,
  source: string,
  originRegion: string,
  destRegion: string,
  equipmentType: string,
  estimated: number,
  actual: number,
) {
  const factor = actual / estimated

  await client.query(
    `INSERT INTO quote_corrections (
       id, source, origin_region, dest_region, equipment_type, correction_factor, sample_size, last_updated
     ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1, NOW())
     ON CONFLICT (source, origin_region, dest_region, equipment_type) DO UPDATE SET
       correction_factor = (quote_corrections.correction_factor * quote_corrections.sample_size + $5) / (quote_corrections.sample_size + 1),
       sample_size = quote_corrections.sample_size + 1,
       last_updated = NOW()`,
    [source, originRegion, destRegion, equipmentType, factor],
  )
}

export async function getQuoteAnalytics(tenantId: number) {
  return withTenant(tenantId, async (client) => {
    const accuracyBySource = (await client.query(
      `SELECT rate_source, AVG(quote_accuracy) as avg_accuracy, COUNT(*) as count
         FROM quotes WHERE quote_accuracy IS NOT NULL
         GROUP BY rate_source`,
    )).rows

    const conversionMetrics = (await client.query(
      `SELECT status, COUNT(*) as count FROM quotes GROUP BY status`,
    )).rows

    const mostQuotedLanes = (await client.query(
      `SELECT origin_region, dest_region, COUNT(*) as quote_count, AVG(shipper_rate) as avg_rate
         FROM quotes
         GROUP BY origin_region, dest_region
         ORDER BY quote_count DESC LIMIT 10`,
    )).rows

    const sourceUtilization = (await client.query(
      `SELECT rate_source, COUNT(*) as count FROM quotes GROUP BY rate_source`,
    )).rows

    const { rows: marginRows } = await client.query(
      `SELECT
         AVG(margin_percent) as avg_quoted_margin,
         AVG(CASE WHEN actual_carrier_cost IS NOT NULL
           THEN (shipper_rate - actual_carrier_cost) / NULLIF(shipper_rate, 0)
         END) as avg_actual_margin
         FROM quotes`,
    )

    const recentQuotes = (await client.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM quotes
         WHERE created_at > NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at)
         ORDER BY date`,
    )).rows

    return {
      accuracyBySource,
      conversionMetrics,
      mostQuotedLanes,
      sourceUtilization,
      marginRealization: marginRows[0] || { avg_quoted_margin: 0, avg_actual_margin: 0 },
      recentQuotes,
    }
  })
}
