const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('driver-token')
}

export function setStoredToken(token: string) {
  localStorage.setItem('driver-token', token)
}

export function clearStoredToken() {
  localStorage.removeItem('driver-token')
  localStorage.removeItem('driver-info')
}

export function getDriverInfo(): { id: string; firstName: string; lastName: string; carrierId: string; carrierName: string } | null {
  if (typeof window === 'undefined') return null
  const info = localStorage.getItem('driver-info')
  if (!info) return null
  try {
    return JSON.parse(info)
  } catch {
    return null
  }
}

export function setDriverInfo(info: { id: string; firstName: string; lastName: string; carrierId: string; carrierName: string }) {
  localStorage.setItem('driver-info', JSON.stringify(info))
}

export function isAuthenticated(): boolean {
  const token = getStoredToken()
  if (!token) return false
  return !isTokenExpired()
}

// ---------------------------------------------------------------------------
// JWT Token Expiry Utilities
// ---------------------------------------------------------------------------

/**
 * Decode the payload of a JWT without verifying the signature.
 * Returns null if the token is malformed.
 */
function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    // Base64url -> Base64 -> decoded string
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Returns true if the stored JWT is expired or will expire within 60 seconds.
 * Also returns true if there is no token or the token is malformed.
 */
export function isTokenExpired(): boolean {
  const token = getStoredToken()
  if (!token) return true

  const payload = decodeTokenPayload(token)
  if (!payload || typeof payload.exp !== 'number') return true

  const nowSeconds = Math.floor(Date.now() / 1000)
  // Treat as expired if within 60 seconds of actual expiry
  return payload.exp - nowSeconds <= 60
}

/**
 * Check token expiry and redirect to login if expired.
 * Intended to be called before making authenticated requests.
 */
export function checkTokenExpiry(): void {
  if (typeof window === 'undefined') return
  const token = getStoredToken()
  if (!token) return // no token — nothing to check

  if (isTokenExpired()) {
    clearStoredToken()
    window.location.href = '/login'
  }
}

/**
 * Returns the number of seconds until the token expires, or 0 if
 * there is no token, the token is malformed, or it is already expired.
 */
export function getTokenTimeRemaining(): number {
  const token = getStoredToken()
  if (!token) return 0

  const payload = decodeTokenPayload(token)
  if (!payload || typeof payload.exp !== 'number') return 0

  const remaining = payload.exp - Math.floor(Date.now() / 1000)
  return remaining > 0 ? remaining : 0
}

/**
 * Starts a background interval that checks token expiry every 30 seconds.
 * If the token has expired, it clears stored credentials and redirects to /login.
 * Returns a cleanup function that stops the monitor.
 *
 * Usage (e.g. in a layout effect):
 *   const stop = startTokenExpiryMonitor()
 *   return () => stop()
 */
export function startTokenExpiryMonitor(): () => void {
  const intervalId = setInterval(() => {
    const token = getStoredToken()
    if (!token) return // not logged in — nothing to monitor

    if (isTokenExpired()) {
      clearStoredToken()
      if (typeof window !== 'undefined') {
        window.location.href = '/login'
      }
    }
  }, 30_000)

  return () => clearInterval(intervalId)
}

// ---------------------------------------------------------------------------

export async function driverFetch(path: string, options?: RequestInit): Promise<Response> {
  // Proactively check token expiry before making the request
  checkTokenExpiry()

  const token = getStoredToken()
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // Only set Content-Type for non-FormData bodies
  if (!(options?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  })

  // If unauthorized, redirect to login
  if (response.status === 401) {
    clearStoredToken()
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  }

  return response
}

export async function driverLogin(carrierCode: string, pin: string): Promise<{
  success: boolean
  error?: string
  driver?: { id: string; firstName: string; lastName: string; carrierId: string; carrierName: string }
}> {
  try {
    const response = await fetch(`${API_URL}/api/auth/driver-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierCode, pin }),
    })

    const data = await response.json()

    if (!response.ok) {
      return { success: false, error: data.error || 'Login failed' }
    }

    // Store the token from the response body
    if (data.token) {
      setStoredToken(data.token)
    }
    if (data.driver) {
      setDriverInfo(data.driver)
    }

    return { success: true, driver: data.driver }
  } catch (error) {
    return { success: false, error: 'Network error. Please check your connection.' }
  }
}
