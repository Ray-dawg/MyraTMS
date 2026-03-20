"use client"

import { useState } from "react"

interface RatingFormProps {
  token: string
  loadRef: string
}

export default function RatingForm({ token, loadRef }: RatingFormProps) {
  const [hoveredStar, setHoveredStar] = useState(0)
  const [selectedStar, setSelectedStar] = useState(0)
  const [comment, setComment] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (selectedStar === 0) {
      setError("Please select a star rating")
      return
    }

    setSubmitting(true)
    setError("")

    try {
      const res = await fetch(`/api/rate/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: selectedStar, comment }),
      })

      if (res.status === 409) {
        setSubmitted(true)
        return
      }

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to submit rating")
      }

      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-4">&#10003;</div>
        <h2 className="text-xl font-semibold text-zinc-900 mb-2">
          Thank you for your feedback!
        </h2>
        <p className="text-zinc-500 text-sm">
          Your rating for load {loadRef} has been recorded.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Star Rating */}
      <div>
        <p className="text-sm font-medium text-zinc-700 mb-3 text-center">
          How would you rate this delivery?
        </p>
        <div className="flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              className="text-4xl transition-transform hover:scale-110 focus:outline-none"
              style={{
                color:
                  star <= (hoveredStar || selectedStar)
                    ? "#f59e0b"
                    : "#d4d4d8",
              }}
              onMouseEnter={() => setHoveredStar(star)}
              onMouseLeave={() => setHoveredStar(0)}
              onClick={() => setSelectedStar(star)}
              aria-label={`${star} star${star > 1 ? "s" : ""}`}
            >
              &#9733;
            </button>
          ))}
        </div>
        {selectedStar > 0 && (
          <p className="text-center text-sm text-zinc-500 mt-2">
            {selectedStar === 1 && "Poor"}
            {selectedStar === 2 && "Fair"}
            {selectedStar === 3 && "Good"}
            {selectedStar === 4 && "Very Good"}
            {selectedStar === 5 && "Excellent"}
          </p>
        )}
      </div>

      {/* Comment */}
      <div>
        <label
          htmlFor="comment"
          className="block text-sm font-medium text-zinc-700 mb-1"
        >
          Comments (optional)
        </label>
        <textarea
          id="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Tell us about your experience..."
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-none"
        />
        <p className="text-right text-xs text-zinc-400 mt-1">
          {comment.length}/500
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600 text-center">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting || selectedStar === 0}
        className="w-full rounded-lg bg-orange-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? "Submitting..." : "Submit Rating"}
      </button>
    </form>
  )
}
