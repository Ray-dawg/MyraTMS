import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { createNotification } from '@/lib/notifications'

/**
 * POST /api/loads/request
 * Driver requests a load when empty. Uses location + equipment to find
 * the best matching available loads. Returns 2-3 options or notifies dispatch.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      driverId,
      driverName,
      carrierId,
      carrierName,
      lat,
      lng,
      equipment = 'Dry Van',
      maxRadius = 200, // miles
    } = body

    if (!driverId) {
      return NextResponse.json({ error: 'driverId required' }, { status: 400 })
    }

    const sql = getDb()

    // Find available (unassigned) loads, ordered by proximity to driver
    // Loads are "available" when: carrier_id IS NULL and status is Posted/Booked
    const availableLoads = await sql`
      SELECT
        id, origin, destination, equipment, weight,
        revenue, carrier_cost, pickup_date, delivery_date,
        lat, lng, shipper_name, status,
        CASE
          WHEN lat IS NOT NULL AND lng IS NOT NULL THEN
            3959 * 2 * ASIN(SQRT(
              POWER(SIN(RADIANS(lat - ${lat || 0}) / 2), 2) +
              COS(RADIANS(${lat || 0})) * COS(RADIANS(lat)) *
              POWER(SIN(RADIANS(lng - ${lng || 0}) / 2), 2)
            ))
          ELSE 9999
        END AS distance_miles
      FROM loads
      WHERE carrier_id IS NULL
        AND status IN ('Posted', 'Booked')
        AND (
          equipment IS NULL
          OR LOWER(equipment) = LOWER(${equipment})
          OR equipment = ''
        )
      ORDER BY distance_miles ASC
      LIMIT 10
    `

    // Filter to maxRadius and take top 3
    const withinRadius = availableLoads
      .filter((l: Record<string, unknown>) =>
        (l.distance_miles as number) <= maxRadius
      )
      .slice(0, 3)

    if (withinRadius.length > 0) {
      return NextResponse.json({
        status: 'matches_found',
        loads: withinRadius.map((l: Record<string, unknown>) => ({
          id: l.id,
          origin: l.origin,
          destination: l.destination,
          equipment: l.equipment,
          weight: l.weight,
          revenue: l.revenue,
          carrierCost: l.carrier_cost,
          pickupDate: l.pickup_date,
          deliveryDate: l.delivery_date,
          shipperName: l.shipper_name,
          distanceMiles: Math.round((l.distance_miles as number) * 10) / 10,
        })),
        message: `Found ${withinRadius.length} available load${withinRadius.length > 1 ? 's' : ''} near you`,
      })
    }

    // No matches — notify dispatch
    await createNotification({
      type: 'alert',
      title: `Driver needs a load`,
      body: `${driverName || 'A driver'} (${carrierName || carrierId}) is empty and requesting a load. Equipment: ${equipment}. Please assign manually.`,
      link: `/drivers`,
    })

    return NextResponse.json({
      status: 'no_matches',
      loads: [],
      message: 'No loads available nearby. Your request has been sent to dispatch — they\'ll find you a load.',
    })
  } catch (err) {
    console.error('Load request error:', err)
    return NextResponse.json(
      { error: 'Failed to process load request' },
      { status: 500 }
    )
  }
}
