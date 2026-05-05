/**
 * Quote feedback loop — records actual carrier costs and updates correction factors.
 * Called when a load tied to a quote is delivered.
 */

import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"

export async function processQuoteFeedback(
  tenantId: number,
  quoteId: string,
  actualCarrierCost: number,
  loadId: string,
) {
  await withTenant(tenantId, async (client) => {
    const { rows: quoteRows } = await client.query(
      `SELECT * FROM quotes WHERE id = $1`,
      [quoteId],
    )
    const quote = quoteRows[0]
    if (!quote) return

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
