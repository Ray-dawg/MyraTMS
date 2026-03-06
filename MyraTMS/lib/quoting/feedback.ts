/**
 * Quote feedback loop — records actual carrier costs and updates correction factors.
 * Called when a load tied to a quote is delivered.
 */

import { getDb } from "@/lib/db"

export async function processQuoteFeedback(
  quoteId: string,
  actualCarrierCost: number,
  loadId: string
) {
  const sql = getDb()
  const quote = (await sql`SELECT * FROM quotes WHERE id = ${quoteId}`)[0]
  if (!quote) return

  const accuracy = 1 - Math.abs(Number(quote.carrier_cost_estimate) - actualCarrierCost) / actualCarrierCost

  await sql`
    UPDATE quotes
    SET actual_carrier_cost = ${actualCarrierCost},
        quote_accuracy = ${accuracy},
        load_id = ${loadId},
        updated_at = NOW()
    WHERE id = ${quoteId}
  `

  // Update correction factors
  await updateCorrectionFactor(
    sql,
    quote.rate_source,
    quote.origin_region,
    quote.dest_region,
    quote.equipment_type,
    Number(quote.carrier_cost_estimate),
    actualCarrierCost
  )
}

async function updateCorrectionFactor(
  sql: ReturnType<typeof getDb>,
  source: string,
  originRegion: string,
  destRegion: string,
  equipmentType: string,
  estimated: number,
  actual: number
) {
  const factor = actual / estimated

  await sql`
    INSERT INTO quote_corrections (id, source, origin_region, dest_region, equipment_type, correction_factor, sample_size, last_updated)
    VALUES (gen_random_uuid(), ${source}, ${originRegion}, ${destRegion}, ${equipmentType}, ${factor}, 1, NOW())
    ON CONFLICT (source, origin_region, dest_region, equipment_type) DO UPDATE SET
      correction_factor = (quote_corrections.correction_factor * quote_corrections.sample_size + ${factor}) / (quote_corrections.sample_size + 1),
      sample_size = quote_corrections.sample_size + 1,
      last_updated = NOW()
  `
}

export async function getQuoteAnalytics() {
  const sql = getDb()

  const accuracyBySource = await sql`
    SELECT rate_source, AVG(quote_accuracy) as avg_accuracy, COUNT(*) as count
    FROM quotes WHERE quote_accuracy IS NOT NULL
    GROUP BY rate_source
  `

  const conversionMetrics = await sql`
    SELECT status, COUNT(*) as count FROM quotes GROUP BY status
  `

  const mostQuotedLanes = await sql`
    SELECT origin_region, dest_region, COUNT(*) as quote_count, AVG(shipper_rate) as avg_rate
    FROM quotes
    GROUP BY origin_region, dest_region
    ORDER BY quote_count DESC LIMIT 10
  `

  const sourceUtilization = await sql`
    SELECT rate_source, COUNT(*) as count FROM quotes GROUP BY rate_source
  `

  const marginRealization = await sql`
    SELECT
      AVG(margin_percent) as avg_quoted_margin,
      AVG(CASE WHEN actual_carrier_cost IS NOT NULL
        THEN (shipper_rate - actual_carrier_cost) / NULLIF(shipper_rate, 0)
      END) as avg_actual_margin
    FROM quotes
  `

  const recentQuotes = await sql`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM quotes
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY date
  `

  return {
    accuracyBySource,
    conversionMetrics,
    mostQuotedLanes,
    sourceUtilization,
    marginRealization: marginRealization[0] || { avg_quoted_margin: 0, avg_actual_margin: 0 },
    recentQuotes,
  }
}
