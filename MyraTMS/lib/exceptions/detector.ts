import { getDb } from "@/lib/db"
import { createNotification } from "@/lib/notifications"

// ---------------------------------------------------------------------------
// Exception Detection Engine
//
// Runs 8 detection rules against the database. For each rule:
// 1. Query for matching loads/carriers
// 2. Deduplicate — skip if an ACTIVE exception of same type+load_id exists
// 3. Insert new exceptions, flag loads.has_exception = true
// 4. Auto-resolve: re-check active exceptions — if condition cleared, resolve
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

export async function runExceptionDetection(): Promise<DetectionResult> {
  const sql = getDb()
  let created = 0
  let resolved = 0

  // ── Fetch check-call reminder settings ──────────────────────────────────
  let checkcallThresholdHours = 4
  let checkcallEnabled = true
  {
    const thresholdRow = await sql`
      SELECT settings_value FROM settings
      WHERE user_id IS NULL AND settings_key = 'checkcall_threshold_hours'
      LIMIT 1
    `
    if (thresholdRow.length > 0) {
      const parsed = parseInt(String(thresholdRow[0].settings_value), 10)
      if (!isNaN(parsed) && parsed > 0) checkcallThresholdHours = parsed
    }

    const enabledRow = await sql`
      SELECT settings_value FROM settings
      WHERE user_id IS NULL AND settings_key = 'notif_checkcall_enabled'
      LIMIT 1
    `
    if (enabledRow.length > 0) {
      const val = enabledRow[0].settings_value
      checkcallEnabled = val === true || val === "true"
    }
  }

  // ── Rule 1: Unassigned Urgent ──────────────────────────────────────────
  {
    const matches = await sql`
      SELECT id, reference_number, pickup_date
      FROM loads
      WHERE pickup_date <= CURRENT_DATE + 1
        AND status = 'Booked'
    `
    for (const load of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'unassigned_urgent' AND load_id = ${load.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${load.id}, NULL, 'unassigned_urgent', 'critical',
            ${"Uncovered Load — " + load.reference_number + " picks up " + load.pickup_date},
            'Load has no carrier assigned and picks up tomorrow or today.'
          )
        `
        await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
        await createNotification({
          type: "unassigned_urgent",
          title: "Uncovered Load — " + load.reference_number,
          body: "Assign a carrier immediately",
          loadId: load.id,
        })
        created++
      }
    }
    // Auto-resolve
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'unassigned_urgent' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const still = await sql`
        SELECT 1 FROM loads
        WHERE id = ${exc.load_id}
          AND pickup_date <= CURRENT_DATE + 1
          AND status = 'Booked'
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 2: Late Pickup ────────────────────────────────────────────────
  {
    const matches = await sql`
      SELECT id, reference_number, origin_city, origin
      FROM loads
      WHERE status = 'Dispatched'
        AND pickup_date < CURRENT_DATE
    `
    for (const load of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'late_pickup' AND load_id = ${load.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${load.id}, NULL, 'late_pickup', 'high',
            ${"Late Pickup — " + load.reference_number + " at " + (load.origin_city || load.origin)},
            'Carrier has not confirmed pickup and scheduled date has passed.'
          )
        `
        await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
        await createNotification({
          type: "late_pickup",
          title: "Late Pickup — " + load.reference_number,
          body: "Carrier has not confirmed pickup and scheduled date has passed.",
          loadId: load.id,
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'late_pickup' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const still = await sql`
        SELECT 1 FROM loads
        WHERE id = ${exc.load_id}
          AND status = 'Dispatched'
          AND pickup_date < CURRENT_DATE
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 3: ETA Breach ─────────────────────────────────────────────────
  {
    const matches = await sql`
      SELECT id, reference_number
      FROM loads
      WHERE status = 'In Transit'
        AND current_eta IS NOT NULL
        AND current_eta > (delivery_date::timestamptz + interval '30 minutes')
    `
    for (const load of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'eta_breach' AND load_id = ${load.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${load.id}, NULL, 'eta_breach', 'high',
            ${"ETA Breach — " + load.reference_number},
            'Current ETA exceeds scheduled delivery window.'
          )
        `
        await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
        await createNotification({
          type: "eta_breach",
          title: "ETA Breach — " + load.reference_number,
          body: "Current ETA exceeds scheduled delivery window.",
          loadId: load.id,
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'eta_breach' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const still = await sql`
        SELECT 1 FROM loads
        WHERE id = ${exc.load_id}
          AND status = 'In Transit'
          AND current_eta IS NOT NULL
          AND current_eta > (delivery_date::timestamptz + interval '30 minutes')
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 4: GPS Dark ───────────────────────────────────────────────────
  {
    const matches = await sql`
      SELECT l.id, l.reference_number, l.carrier_name
      FROM loads l
      WHERE l.status = 'In Transit'
        AND l.last_ping_at IS NOT NULL
        AND l.last_ping_at < NOW() - interval '30 minutes'
    `
    for (const load of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'gps_dark' AND load_id = ${load.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${load.id}, NULL, 'gps_dark', 'medium',
            ${"GPS Signal Lost — " + load.reference_number + " (" + (load.carrier_name || "Unknown") + ")"},
            'No location update received in over 30 minutes.'
          )
        `
        await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
        await createNotification({
          type: "gps_dark",
          title: "GPS Signal Lost — " + load.reference_number,
          body: "No location update received in over 30 minutes.",
          loadId: load.id,
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'gps_dark' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const still = await sql`
        SELECT 1 FROM loads
        WHERE id = ${exc.load_id}
          AND status = 'In Transit'
          AND last_ping_at IS NOT NULL
          AND last_ping_at < NOW() - interval '30 minutes'
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 5: POD Missing ────────────────────────────────────────────────
  {
    const matches = await sql`
      SELECT id, reference_number
      FROM loads
      WHERE status IN ('Delivered', 'Invoiced')
        AND pod_url IS NULL
        AND delivered_at < NOW() - interval '24 hours'
    `
    for (const load of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'pod_missing' AND load_id = ${load.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${load.id}, NULL, 'pod_missing', 'low',
            ${"POD Missing — " + load.reference_number},
            'Load was delivered over 24 hours ago but no POD has been uploaded.'
          )
        `
        await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
        await createNotification({
          type: "pod_missing",
          title: "POD Missing — " + load.reference_number,
          body: "Load was delivered over 24 hours ago but no POD has been uploaded.",
          loadId: load.id,
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'pod_missing' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const still = await sql`
        SELECT 1 FROM loads
        WHERE id = ${exc.load_id}
          AND status IN ('Delivered', 'Invoiced')
          AND pod_url IS NULL
          AND delivered_at < NOW() - interval '24 hours'
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 6: Invoice Overdue ────────────────────────────────────────────
  {
    const matches = await sql`
      SELECT i.id AS invoice_id, i.load_id, i.amount, i.due_date,
             l.reference_number
      FROM invoices i
      LEFT JOIN loads l ON i.load_id = l.id
      WHERE i.status = 'Overdue'
        AND i.due_date < CURRENT_DATE
    `
    for (const row of matches) {
      const loadId = row.load_id || null
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'invoice_overdue'
          AND load_id = ${loadId}
          AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        const amount = Number(row.amount || 0).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        })
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            ${loadId}, NULL, 'invoice_overdue', 'medium',
            ${`Overdue Invoice — ${row.reference_number || row.invoice_id}`},
            ${`${amount} overdue — ${row.due_date}`}
          )
        `
        if (loadId) {
          await sql`UPDATE loads SET has_exception = true WHERE id = ${loadId}`
        }
        await createNotification({
          type: "invoice_overdue",
          title: `Overdue Invoice — ${row.reference_number || row.invoice_id}`,
          body: `${amount} overdue — ${row.due_date}`,
          loadId,
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'invoice_overdue' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      const still = exc.load_id
        ? await sql`
            SELECT 1 FROM invoices
            WHERE load_id = ${exc.load_id}
              AND status = 'Overdue'
              AND due_date < CURRENT_DATE
            LIMIT 1
          `
        : []
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 7: Insurance Expiring ─────────────────────────────────────────
  {
    const matches = await sql`
      SELECT id, company, insurance_expiry
      FROM carriers
      WHERE insurance_expiry <= CURRENT_DATE + interval '30 days'
        AND insurance_expiry >= CURRENT_DATE
        AND authority_status = 'Active'
    `
    for (const carrier of matches) {
      const exists = await sql`
        SELECT 1 FROM exceptions
        WHERE type = 'insurance_expiring' AND carrier_id = ${carrier.id} AND status = 'active'
        LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
          VALUES (
            NULL, ${carrier.id}, 'insurance_expiring', 'low',
            ${"Insurance Expiring — " + carrier.company},
            ${"Insurance expires on " + carrier.insurance_expiry + ". Update before assigning loads."}
          )
        `
        await createNotification({
          type: "insurance_expiring",
          title: "Insurance Expiring — " + carrier.company,
          body: "Insurance expires on " + carrier.insurance_expiry + ". Update before assigning loads.",
        })
        created++
      }
    }
    const active = await sql`
      SELECT id, load_id, carrier_id FROM exceptions
      WHERE type = 'insurance_expiring' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.carrier_id) continue
      const still = await sql`
        SELECT 1 FROM carriers
        WHERE id = ${exc.carrier_id}
          AND insurance_expiry <= CURRENT_DATE + interval '30 days'
          AND insurance_expiry >= CURRENT_DATE
          AND authority_status = 'Active'
        LIMIT 1
      `
      if (still.length === 0) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  // ── Rule 8: Missing Check-Call ─────────────────────────────────────────
  if (checkcallEnabled) {
    const inTransit = await sql`
      SELECT id, reference_number, assigned_rep, current_lat, current_lng
      FROM loads
      WHERE status = 'In Transit'
    `
    for (const load of inTransit) {
      const lastGps = await sql`
        SELECT MAX(recorded_at) as last_ping FROM location_pings WHERE load_id = ${load.id}
      `
      const lastCall = await sql`
        SELECT MAX(created_at) as last_call FROM check_calls WHERE load_id = ${load.id}
      `
      const lastPingTime = lastGps[0]?.last_ping ? new Date(lastGps[0].last_ping).getTime() : 0
      const lastCallTime = lastCall[0]?.last_call ? new Date(lastCall[0].last_call).getTime() : 0
      const lastContactTime = Math.max(lastPingTime, lastCallTime)
      const hoursElapsed = lastContactTime > 0
        ? (Date.now() - lastContactTime) / (1000 * 60 * 60)
        : Infinity

      if (hoursElapsed > checkcallThresholdHours) {
        const exists = await sql`
          SELECT 1 FROM exceptions
          WHERE type = 'missing_checkcall' AND load_id = ${load.id} AND status = 'active'
          LIMIT 1
        `
        if (exists.length === 0) {
          // Look up user ID from assigned_rep name
          let userId: string | null = null
          if (load.assigned_rep) {
            const userRows = await sql`
              SELECT id FROM users
              WHERE CONCAT(first_name, ' ', last_name) = ${load.assigned_rep}
              LIMIT 1
            `
            if (userRows.length > 0) userId = userRows[0].id
          }

          const hourLabel = hoursElapsed === Infinity
            ? "no contact recorded"
            : `${Math.round(hoursElapsed)}h since last contact`

          await sql`
            INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail)
            VALUES (
              ${load.id}, NULL, 'missing_checkcall', 'medium',
              ${"No Contact \u2014 " + load.reference_number},
              ${hourLabel}
            )
          `
          await sql`UPDATE loads SET has_exception = true WHERE id = ${load.id}`
          await createNotification({
            userId,
            type: "missing_checkcall",
            title: "No Contact \u2014 " + load.reference_number,
            body: `Load ${load.reference_number} — ${hourLabel}`,
            link: `/loads/${load.id}`,
            loadId: load.id,
          })
          created++
        }
      }
    }
    // Auto-resolve
    const active = await sql`
      SELECT id, load_id FROM exceptions
      WHERE type = 'missing_checkcall' AND status = 'active'
    ` as ExceptionRow[]
    for (const exc of active) {
      if (!exc.load_id) continue
      const lastGps = await sql`
        SELECT MAX(recorded_at) as last_ping FROM location_pings WHERE load_id = ${exc.load_id}
      `
      const lastCall = await sql`
        SELECT MAX(created_at) as last_call FROM check_calls WHERE load_id = ${exc.load_id}
      `
      const lastPingTime = lastGps[0]?.last_ping ? new Date(lastGps[0].last_ping).getTime() : 0
      const lastCallTime = lastCall[0]?.last_call ? new Date(lastCall[0].last_call).getTime() : 0
      const lastContactTime = Math.max(lastPingTime, lastCallTime)
      const hoursElapsed = lastContactTime > 0
        ? (Date.now() - lastContactTime) / (1000 * 60 * 60)
        : Infinity

      if (hoursElapsed <= checkcallThresholdHours) {
        await resolveException(sql, exc)
        resolved++
      }
    }
  }

  console.log(`[exception-detect] created=${created} resolved=${resolved}`)
  return { created, resolved }
}

// ---------------------------------------------------------------------------
// Helper: resolve an exception and clear has_exception if no others remain
// ---------------------------------------------------------------------------
async function resolveException(
  sql: ReturnType<typeof getDb>,
  exc: ExceptionRow
) {
  await sql`
    UPDATE exceptions
    SET status = 'resolved', resolved_at = NOW()
    WHERE id = ${exc.id}
  `
  if (exc.load_id) {
    const others = await sql`
      SELECT 1 FROM exceptions
      WHERE load_id = ${exc.load_id} AND status = 'active' AND id != ${exc.id}
      LIMIT 1
    `
    if (others.length === 0) {
      await sql`UPDATE loads SET has_exception = false WHERE id = ${exc.load_id}`
    }
  }
}
