import { verifyRatingToken } from "@/lib/rating-token"
import { getDb } from "@/lib/db"
import RatingForm from "./rating-form"

export const dynamic = "force-dynamic"

export default async function RatePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ stars?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  // Verify token
  const payload = verifyRatingToken(token)
  if (!payload) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-zinc-200 p-8 text-center">
          <div className="text-4xl mb-4">&#128337;</div>
          <h1 className="text-xl font-semibold text-zinc-900 mb-2">
            Link Expired
          </h1>
          <p className="text-zinc-500 text-sm">
            This rating link has expired or is no longer valid. Rating links are
            available for 72 hours after delivery.
          </p>
        </div>
      </div>
    )
  }

  const sql = getDb()

  // Check if already rated
  const existingRatings = await sql`
    SELECT rating FROM delivery_ratings WHERE load_id = ${payload.loadId} AND shipper_id = ${payload.shipperId} LIMIT 1
  `
  if (existingRatings.length > 0) {
    const existingRating = existingRatings[0].rating as number
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-zinc-200 p-8 text-center">
          <div className="text-4xl mb-4">&#10003;</div>
          <h1 className="text-xl font-semibold text-zinc-900 mb-2">
            Already Rated
          </h1>
          <p className="text-zinc-500 text-sm">
            You already submitted a rating of {existingRating}/5 for this
            delivery. Thank you for your feedback!
          </p>
        </div>
      </div>
    )
  }

  // Get load info
  const loads = await sql`
    SELECT reference_number, origin_city, destination_city, origin, destination
    FROM loads WHERE id = ${payload.loadId} LIMIT 1
  `
  const load = loads[0] || {}
  const loadRef = (load.reference_number || payload.loadId) as string
  const origin = (load.origin_city || load.origin || "N/A") as string
  const destination = (load.destination_city || load.destination || "N/A") as string

  // Pre-selected star from email link
  const preselectedStar = query.stars ? parseInt(query.stars, 10) : undefined

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-zinc-200 overflow-hidden">
        {/* Header */}
        <div className="bg-slate-900 px-6 py-4 flex items-center gap-3">
          <div className="w-8 h-8 bg-orange-600 rounded-lg" />
          <div>
            <span className="text-white text-lg font-semibold">Myra</span>
            <span className="text-orange-500 text-lg font-semibold"> AI</span>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          <h1 className="text-lg font-semibold text-zinc-900 mb-1">
            Rate Your Delivery
          </h1>
          <p className="text-sm text-zinc-500 mb-6">
            Load <span className="font-medium text-zinc-700">{loadRef}</span>
            {" — "}
            {origin} to {destination}
          </p>

          <RatingForm
            token={token}
            loadRef={loadRef}
            key={preselectedStar}
          />
        </div>
      </div>
    </div>
  )
}
