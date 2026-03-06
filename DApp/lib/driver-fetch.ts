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

export interface DriverInfo {
  id: string
  firstName: string
  lastName: string
  carrierId: string
  carrierName: string
}

export function getDriverInfo(): DriverInfo | null {
  if (typeof window === 'undefined') return null
  const info = localStorage.getItem('driver-info')
  if (!info) return null
  try { return JSON.parse(info) } catch { return null }
}

export function setDriverInfo(info: DriverInfo) {
  localStorage.setItem('driver-info', JSON.stringify(info))
}

function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch { return null }
}

export function isTokenExpired(): boolean {
  const token = getStoredToken()
  if (!token) return true
  const payload = decodeTokenPayload(token)
  if (!payload || typeof payload.exp !== 'number') return true
  return payload.exp - Math.floor(Date.now() / 1000) <= 60
}

export function isAuthenticated(): boolean {
  return !!getStoredToken() && !isTokenExpired()
}

export function checkTokenExpiry(): void {
  if (typeof window === 'undefined') return
  if (!getStoredToken()) return
  if (isTokenExpired()) {
    clearStoredToken()
    window.location.href = '/login'
  }
}

export function startTokenExpiryMonitor(): () => void {
  const id = setInterval(() => {
    if (!getStoredToken()) return
    if (isTokenExpired()) {
      clearStoredToken()
      if (typeof window !== 'undefined') window.location.href = '/login'
    }
  }, 30_000)
  return () => clearInterval(id)
}

export async function driverFetch(path: string, options?: RequestInit): Promise<Response> {
  checkTokenExpiry()
  const token = getStoredToken()
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (!(options?.body instanceof FormData)) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (response.status === 401) {
    clearStoredToken()
    if (typeof window !== 'undefined') window.location.href = '/login'
  }
  return response
}

export async function driverLogin(carrierCode: string, pin: string): Promise<{
  success: boolean
  error?: string
  driver?: DriverInfo
}> {
  try {
    const response = await fetch(`${API_URL}/api/auth/driver-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierCode, pin }),
    })
    const data = await response.json()
    if (!response.ok) return { success: false, error: data.error || 'Login failed' }
    if (data.token) setStoredToken(data.token)
    if (data.driver) setDriverInfo(data.driver)
    return { success: true, driver: data.driver }
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' }
  }
}
