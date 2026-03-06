'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { isAuthenticated, clearStoredToken, getDriverInfo } from '@/lib/api'

interface DriverInfo {
  id: string
  firstName: string
  lastName: string
  carrierId: string
  carrierName: string
}

export function useAuth() {
  const router = useRouter()
  const [authenticated, setAuthenticated] = useState(false)
  const [driver, setDriver] = useState<DriverInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const authed = isAuthenticated()
    setAuthenticated(authed)
    if (authed) {
      setDriver(getDriverInfo())
    }
    setLoading(false)
  }, [])

  const logout = useCallback(() => {
    clearStoredToken()
    setAuthenticated(false)
    setDriver(null)
    router.push('/login')
  }, [router])

  const requireAuth = useCallback(() => {
    if (!loading && !authenticated) {
      router.push('/login')
    }
  }, [loading, authenticated, router])

  return {
    authenticated,
    driver,
    loading,
    logout,
    requireAuth,
  }
}
