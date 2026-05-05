import { withTenant } from "@/lib/db/tenant-context"
import { createNotification } from "@/lib/notifications"
import type { PoolClient } from "@neondatabase/serverless"

// ---------------------------------------------------------------------------
// Exception Detection Engine
//
// Runs 8 detection rules against the database. For each rule:
// 1. Query for matching loads/carriers
// 2. Deduplicate — skip if an ACTIVE exception of same type+load_id exists
// 3. Insert new exceptions, flag loads.has_exception = true
// 4. Auto-resolve: re-check active exceptions — if condition cleared, resolve
//
// Per-tenant invocation:
//   await runExceptionDetection(tenantId)
//
// All queries run inside a single withTenant transaction so RLS + tenant
// audit boundaries are preserved.
// ---------------------------------------------------------------------------

interface DetectionResult {
  created: number
  resolved: number
}

interface ExceptionRow {
  id: string
  load_id: string | null
  carrier_id: string | null
}

export async function runExceptionDetection(tenantId: number): Promise<DetectionResult> {
  let created = 0
  let resolved = 0

  await withTenant(tenantId, async (client) => {
    // ── Fetch check-call reminder settings ──────────────────────────────────
    let checkcallThresholdHours = 4
    let checkcallEnabled = true
    {
      const { rows: thresholdRow } = await client.query(
        `SELECT settings_value FROM settings
          WHERE user_id IS NULL AND settings_key = 'checkcall_threshold_hours'
          LIMIT 1`,
      )
      if (thresholdRow.length > 0) {
        const parsed = Number.parseInt(String(thresholdRow[0].settings_value), 10)
        if (!Number.isNaN(parsed) && parsed > 0) checkcallThresholdHours = parsed
      }

      const { rows: enabledRow } = await client.query(
        `SELECT settings_value FROM settings
          WHERE user_id IS NULL AND settings_key = 'notif_checkcall_enabled'
          LIMIT 1`,
      )
      if (enabledRow.length > 0) {
        const val = enabledRow[0].settings_value
        checkcallEnabled = val === true || val === "true"
      }
    }

    // ── Rule 1: Unassigned Urgent ──────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT id, reference_number, pickup_date FROM loads
          WHERE pickup_date <= CURRENT_DATE + 1 AND status = 'Booked'`,
      )
      for (const load of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'unassigned_urgent' AND load_id = $1 AND status = 'active'
            LIMIT 1`,
          [load.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'unassigned_urgent', 'critical', $2, $3)`,
            [
              load.id,
              `Uncovered Load — ${load.reference_number} picks up ${load.pickup_date}`,
              "Load has no carrier assigned and picks up tomorrow or today.",
            ],
          )
          await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
          await createNotification({
            tenantId,
            type: "unassigned_urgent",
            title: `Uncovered Load — ${load.reference_number}`,
            body: "Assign a carrier immediately",
            loadId: load.id,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions
          WHERE type = 'unassigned_urgent' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM loads
            WHERE id = $1 AND pickup_date <= CURRENT_DATE + 1 AND status = 'Booked'
            LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 2: Late Pickup ────────────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT id, reference_number, origin_city, origin FROM loads
          WHERE status = 'Dispatched' AND pickup_date < CURRENT_DATE`,
      )
      for (const load of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'late_pickup' AND load_id = $1 AND status = 'active' LIMIT 1`,
          [load.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'late_pickup', 'high', $2, $3)`,
            [
              load.id,
              `Late Pickup — ${load.reference_number} at ${load.origin_city || load.origin}`,
              "Carrier has not confirmed pickup and scheduled date has passed.",
            ],
          )
          await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
          await createNotification({
            tenantId,
            type: "late_pickup",
            title: `Late Pickup — ${load.reference_number}`,
            body: "Carrier has not confirmed pickup and scheduled date has passed.",
            loadId: load.id,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'late_pickup' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM loads
            WHERE id = $1 AND status = 'Dispatched' AND pickup_date < CURRENT_DATE
            LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 3: ETA Breach ─────────────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT id, reference_number FROM loads
          WHERE status = 'In Transit'
            AND current_eta IS NOT NULL
            AND current_eta > (delivery_date::timestamptz + interval '30 minutes')`,
      )
      for (const load of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'eta_breach' AND load_id = $1 AND status = 'active' LIMIT 1`,
          [load.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'eta_breach', 'high', $2, 'Current ETA exceeds scheduled delivery window.')`,
            [load.id, `ETA Breach — ${load.reference_number}`],
          )
          await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
          await createNotification({
            tenantId,
            type: "eta_breach",
            title: `ETA Breach — ${load.reference_number}`,
            body: "Current ETA exceeds scheduled delivery window.",
            loadId: load.id,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'eta_breach' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM loads
            WHERE id = $1
              AND status = 'In Transit'
              AND current_eta IS NOT NULL
              AND current_eta > (delivery_date::timestamptz + interval '30 minutes')
            LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 4: GPS Dark ───────────────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT l.id, l.reference_number, l.carrier_name FROM loads l
          WHERE l.status = 'In Transit'
            AND l.last_ping_at IS NOT NULL
            AND l.last_ping_at < NOW() - interval '30 minutes'`,
      )
      for (const load of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'gps_dark' AND load_id = $1 AND status = 'active' LIMIT 1`,
          [load.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'gps_dark', 'medium', $2, 'No location update received in over 30 minutes.')`,
            [load.id, `GPS Signal Lost — ${load.reference_number} (${load.carrier_name || "Unknown"})`],
          )
          await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
          await createNotification({
            tenantId,
            type: "gps_dark",
            title: `GPS Signal Lost — ${load.reference_number}`,
            body: "No location update received in over 30 minutes.",
            loadId: load.id,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'gps_dark' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM loads
            WHERE id = $1 AND status = 'In Transit'
              AND last_ping_at IS NOT NULL
              AND last_ping_at < NOW() - interval '30 minutes'
            LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 5: POD Missing ────────────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT id, reference_number FROM loads
          WHERE status IN ('Delivered', 'Invoiced')
            AND pod_url IS NULL
            AND delivered_at < NOW() - interval '24 hours'`,
      )
      for (const load of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'pod_missing' AND load_id = $1 AND status = 'active' LIMIT 1`,
          [load.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'pod_missing', 'low', $2, 'Load was delivered over 24 hours ago but no POD has been uploaded.')`,
            [load.id, `POD Missing — ${load.reference_number}`],
          )
          await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
          await createNotification({
            tenantId,
            type: "pod_missing",
            title: `POD Missing — ${load.reference_number}`,
            body: "Load was delivered over 24 hours ago but no POD has been uploaded.",
            loadId: load.id,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'pod_missing' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM loads
            WHERE id = $1
              AND status IN ('Delivered', 'Invoiced')
              AND pod_url IS NULL
              AND delivered_at < NOW() - interval '24 hours'
            LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 6: Invoice Overdue ────────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT i.id AS invoice_id, i.load_id, i.amount, i.due_date, l.reference_number
           FROM invoices i
           LEFT JOIN loads l ON i.load_id = l.id
          WHERE i.status = 'Overdue' AND i.due_date < CURRENT_DATE`,
      )
      for (const row of matches) {
        const loadId = row.load_id || null
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'invoice_overdue' AND load_id = $1 AND status = 'active' LIMIT 1`,
          [loadId],
        )
        if (exists.length === 0) {
          const amount = Number(row.amount || 0).toLocaleString("en-US", {
            style: "currency",
            currency: "USD",
          })
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES ($1, NULL, 'invoice_overdue', 'medium', $2, $3)`,
            [
              loadId,
              `Overdue Invoice — ${row.reference_number || row.invoice_id}`,
              `${amount} overdue — ${row.due_date}`,
            ],
          )
          if (loadId) {
            await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [loadId])
          }
          await createNotification({
            tenantId,
            type: "invoice_overdue",
            title: `Overdue Invoice — ${row.reference_number || row.invoice_id}`,
            body: `${amount} overdue — ${row.due_date}`,
            loadId,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'invoice_overdue' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM invoices
            WHERE load_id = $1 AND status = 'Overdue' AND due_date < CURRENT_DATE LIMIT 1`,
          [exc.load_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 7: Insurance Expiring ─────────────────────────────────────────
    {
      const { rows: matches } = await client.query(
        `SELECT id, company, insurance_expiry FROM carriers
          WHERE insurance_expiry <= CURRENT_DATE + interval '30 days'
            AND insurance_expiry >= CURRENT_DATE
            AND authority_status = 'Active'`,
      )
      for (const carrier of matches) {
        const { rows: exists } = await client.query(
          `SELECT 1 FROM exceptions
            WHERE type = 'insurance_expiring' AND carrier_id = $1 AND status = 'active' LIMIT 1`,
          [carrier.id],
        )
        if (exists.length === 0) {
          await client.query(
            `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
             VALUES (NULL, $1, 'insurance_expiring', 'low', $2, $3)`,
            [
              carrier.id,
              `Insurance Expiring — ${carrier.company}`,
              `Insurance expires on ${carrier.insurance_expiry}. Update before assigning loads.`,
            ],
          )
          await createNotification({
            tenantId,
            type: "insurance_expiring",
            title: `Insurance Expiring — ${carrier.company}`,
            body: `Insurance expires on ${carrier.insurance_expiry}. Update before assigning loads.`,
          })
          created++
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id, carrier_id FROM exceptions
          WHERE type = 'insurance_expiring' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.carrier_id) continue
        const { rows: still } = await client.query(
          `SELECT 1 FROM carriers
            WHERE id = $1
              AND insurance_expiry <= CURRENT_DATE + interval '30 days'
              AND insurance_expiry >= CURRENT_DATE
              AND authority_status = 'Active'
            LIMIT 1`,
          [exc.carrier_id],
        )
        if (still.length === 0) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }

    // ── Rule 8: Missing Check-Call ─────────────────────────────────────────
    if (checkcallEnabled) {
      const { rows: inTransit } = await client.query(
        `SELECT id, reference_number, assigned_rep, current_lat, current_lng FROM loads
          WHERE status = 'In Transit'`,
      )
      for (const load of inTransit) {
        const { rows: lastGps } = await client.query(
          `SELECT MAX(recorded_at) as last_ping FROM location_pings WHERE load_id = $1`,
          [load.id],
        )
        const { rows: lastCall } = await client.query(
          `SELECT MAX(created_at) as last_call FROM check_calls WHERE load_id = $1`,
          [load.id],
        )
        const lastPingTime = lastGps[0]?.last_ping ? new Date(lastGps[0].last_ping).getTime() : 0
        const lastCallTime = lastCall[0]?.last_call ? new Date(lastCall[0].last_call).getTime() : 0
        const lastContactTime = Math.max(lastPingTime, lastCallTime)
        const hoursElapsed =
          lastContactTime > 0 ? (Date.now() - lastContactTime) / (1000 * 60 * 60) : Infinity

        if (hoursElapsed > checkcallThresholdHours) {
          const { rows: exists } = await client.query(
            `SELECT 1 FROM exceptions
              WHERE type = 'missing_checkcall' AND load_id = $1 AND status = 'active' LIMIT 1`,
            [load.id],
          )
          if (exists.length === 0) {
            let userId: string | null = null
            if (load.assigned_rep) {
              const { rows: userRows } = await client.query(
                `SELECT id FROM users
                  WHERE CONCAT(first_name, ' ', last_name) = $1 LIMIT 1`,
                [load.assigned_rep],
              )
              if (userRows.length > 0) userId = userRows[0].id
            }

            const hourLabel =
              hoursElapsed === Infinity
                ? "no contact recorded"
                : `${Math.round(hoursElapsed)}h since last contact`

            await client.query(
              `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
               VALUES ($1, NULL, 'missing_checkcall', 'medium', $2, $3)`,
              [load.id, `No Contact — ${load.reference_number}`, hourLabel],
            )
            await client.query(`UPDATE loads SET has_exception = true WHERE id = $1`, [load.id])
            await createNotification({
              tenantId,
              userId,
              type: "missing_checkcall",
              title: `No Contact — ${load.reference_number}`,
              body: `Load ${load.reference_number} — ${hourLabel}`,
              link: `/loads/${load.id}`,
              loadId: load.id,
            })
            created++
          }
        }
      }
      const { rows: active } = await client.query<ExceptionRow>(
        `SELECT id, load_id FROM exceptions WHERE type = 'missing_checkcall' AND status = 'active'`,
      )
      for (const exc of active) {
        if (!exc.load_id) continue
        const { rows: lastGps } = await client.query(
          `SELECT MAX(recorded_at) as last_ping FROM location_pings WHERE load_id = $1`,
          [exc.load_id],
        )
        const { rows: lastCall } = await client.query(
          `SELECT MAX(created_at) as last_call FROM check_calls WHERE load_id = $1`,
          [exc.load_id],
        )
        const lastPingTime = lastGps[0]?.last_ping ? new Date(lastGps[0].last_ping).getTime() : 0
        const lastCallTime = lastCall[0]?.last_call ? new Date(lastCall[0].last_call).getTime() : 0
        const lastContactTime = Math.max(lastPingTime, lastCallTime)
        const hoursElapsed =
          lastContactTime > 0 ? (Date.now() - lastContactTime) / (1000 * 60 * 60) : Infinity

        if (hoursElapsed <= checkcallThresholdHours) {
          await resolveException(client, exc)
          resolved++
        }
      }
    }
  })

  console.log(`[exception-detect tenant=${tenantId}] created=${created} resolved=${resolved}`)
  return { created, resolved }
}

async function resolveException(client: PoolClient, exc: ExceptionRow) {
  await client.query(
    `UPDATE exceptions SET status = 'resolved', resolved_at = NOW() WHERE id = $1`,
    [exc.id],
  )
  if (exc.load_id) {
    const { rows: others } = await client.query(
      `SELECT 1 FROM exceptions
        WHERE load_id = $1 AND status = 'active' AND id != $2 LIMIT 1`,
      [exc.load_id, exc.id],
    )
    if (others.length === 0) {
      await client.query(`UPDATE loads SET has_exception = false WHERE id = $1`, [exc.load_id])
    }
  }
}
