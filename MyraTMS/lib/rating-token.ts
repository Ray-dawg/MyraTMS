import crypto from "crypto"

/**
 * Generate a tamper-proof rating token for shipper delivery feedback.
 * Format: base64url(payload).hmacSignature
 */
export function generateRatingToken(loadId: string, shipperId: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error("JWT_SECRET is required for rating tokens")

  const expiryTimestamp = Math.floor(Date.now() / 1000) + 72 * 60 * 60 // 72h from now
  const payload = `${loadId}|${shipperId}|${expiryTimestamp}`
  const encodedPayload = Buffer.from(payload).toString("base64url")
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url")

  return `${encodedPayload}.${signature}`
}

/**
 * Verify a rating token and return the decoded payload, or null if invalid/expired.
 */
export function verifyRatingToken(
  token: string
): { loadId: string; shipperId: string } | null {
  try {
    const secret = process.env.JWT_SECRET
    if (!secret) return null

    const parts = token.split(".")
    if (parts.length !== 2) return null

    const [encodedPayload, signature] = parts

    // Verify HMAC signature
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url")

    if (signature !== expectedSignature) return null

    // Decode and parse payload
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf-8")
    const [loadId, shipperId, expiryStr] = payload.split("|")

    if (!loadId || !shipperId || !expiryStr) return null

    // Check expiry
    const expiry = parseInt(expiryStr, 10)
    if (isNaN(expiry) || expiry < Math.floor(Date.now() / 1000)) return null

    return { loadId, shipperId }
  } catch {
    return null
  }
}
