import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"

// ---------------------------------------------------------------------------
// Driver scoping (added 2026-10-08).
//
// middleware.ts grants a driver JWT exact-match access to /api/documents,
// because DApp/components/docs-screen.tsx:81 fetches
// `/api/documents?relatedType=Load`. That query string supplies relatedType
// but NOT relatedTo, and the first branch below only fires when BOTH are
// present -- so a driver token fell through to the unfiltered
// `SELECT * FROM documents` and received the ENTIRE tenant's document set:
// carrier rate confirmations, invoices and signed shipper rate-cons included.
// There is no role check in this handler, so middleware's allowlist was the
// only gate, and an allowlist was never meant to be a row-level boundary.
//
// The fix belongs here rather than in middleware: the DApp Docs tab is a
// legitimate caller, it just must not see other people's loads.
//
// Relationship, from the real schema (do not re-derive it by guessing):
//   loads.driver_id UUID REFERENCES drivers(id)  scripts/010-m1-migration.sql:128
//   documents.related_type = 'Load'
//     AND documents.related_to = loads.id        scripts/001-create-tables.sql:106-107
//   a driver JWT's `userId` claim IS drivers.id  app/api/auth/driver-login/route.ts:58
// loads.id is TEXT and drivers.id is UUID, hence the explicit ::uuid cast on
// the parameter (mirrors app/api/drivers/me/loads/route.ts, which compares
// l.driver_id against the same claim).
//
// Deliberately NOT filtered by load status: the Docs tab shows historical
// PODs/BOLs, so unlike /api/drivers/me/loads this must span delivered loads.
//
// Non-driver roles keep the previous behaviour exactly.
// ---------------------------------------------------------------------------

/** drivers.id is a Postgres UUID; anything else must not reach the ::uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * SQL predicate limiting documents to loads assigned to one driver.
 * `param` is a placeholder literal ("$1") constructed in code below, never
 * taken from user input.
 */
function driverLoadScope(param: string): string {
  return `related_type = 'Load'
            AND related_to IN (SELECT id FROM loads WHERE driver_id = ${param}::uuid)`
}

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const relatedTo = req.nextUrl.searchParams.get("relatedTo")
  const relatedType = req.nextUrl.searchParams.get("relatedType")
  const search = req.nextUrl.searchParams.get("search")

  const isDriver = ctx.role === "driver"

  // Fail closed: a driver principal whose userId is not a drivers.id UUID
  // sees nothing, rather than falling through to an unscoped query or
  // throwing an invalid-cast 500.
  if (isDriver && !UUID_RE.test(ctx.userId)) {
    return NextResponse.json([])
  }

  // Each branch keeps the driver and non-driver statements SEPARATE rather
  // than interpolating a conditional fragment into one string. More verbose,
  // but it makes the non-driver SQL byte-for-byte what it was before this
  // change -- including the absent second argument on the bare list query --
  // so no broker-facing read can regress. Enabling middleware is a one-way
  // door; this is not the commit to also perturb a working query.
  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (relatedTo && relatedType) {
      if (isDriver) {
        const { rows } = await client.query(
          `SELECT * FROM documents
            WHERE related_to = $1 AND related_type = $2
              AND ${driverLoadScope("$3")}
            ORDER BY created_at DESC`,
          [relatedTo, relatedType, ctx.userId],
        )
        return rows
      }
      const { rows } = await client.query(
        `SELECT * FROM documents
          WHERE related_to = $1 AND related_type = $2
          ORDER BY created_at DESC`,
        [relatedTo, relatedType],
      )
      return rows
    }
    if (search) {
      const like = `%${escapeLikeMeta(search)}%`
      if (isDriver) {
        // NOTE the parentheses around the OR. Without them, AND binds tighter
        // than OR and `name ILIKE $1` alone would satisfy the WHERE clause --
        // leaking every document whose NAME matched, regardless of load.
        const { rows } = await client.query(
          `SELECT * FROM documents
            WHERE (name ILIKE $1 OR related_to ILIKE $1)
              AND ${driverLoadScope("$2")}
            ORDER BY created_at DESC`,
          [like, ctx.userId],
        )
        return rows
      }
      const { rows } = await client.query(
        `SELECT * FROM documents
          WHERE name ILIKE $1 OR related_to ILIKE $1
          ORDER BY created_at DESC`,
        [like],
      )
      return rows
    }
    // The DApp Docs tab lands here: ?relatedType=Load supplies relatedType but
    // no relatedTo, so the first branch does not fire. THIS is the query that
    // used to return the whole tenant's documents to a driver token.
    if (isDriver) {
      const { rows } = await client.query(
        `SELECT * FROM documents
          WHERE ${driverLoadScope("$1")}
          ORDER BY created_at DESC`,
        [ctx.userId],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM documents ORDER BY created_at DESC`,
    )
    return rows
  })

  return NextResponse.json(rows)
}
