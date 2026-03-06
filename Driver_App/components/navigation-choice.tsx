'use client'

import { useState, useEffect } from 'react'
import { Navigation, ExternalLink, Map } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface NavigationChoiceProps {
  address: string
  lat?: number | null
  lng?: number | null
  label?: string
}

function detectPlatform(): 'ios' | 'android' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  return 'desktop'
}

function buildMapsUrl(address: string, lat?: number | null, lng?: number | null): {
  google: string
  apple: string
} {
  const destination = lat && lng ? `${lat},${lng}` : encodeURIComponent(address)
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${destination}`,
    apple: `maps://maps.apple.com/?daddr=${destination}`,
  }
}

export function NavigationChoice({ address, lat, lng, label }: NavigationChoiceProps) {
  const [preference, setPreference] = useState<'native' | 'none'>('none')
  const platform = detectPlatform()

  useEffect(() => {
    const saved = localStorage.getItem('nav-preference')
    if (saved === 'native') setPreference('native')
  }, [])

  function openNativeMaps() {
    const urls = buildMapsUrl(address, lat, lng)

    if (platform === 'ios') {
      // Try Apple Maps first, fallback to Google Maps
      window.location.href = urls.apple
      setTimeout(() => {
        window.open(urls.google, '_blank')
      }, 500)
    } else {
      // Android or desktop: use Google Maps
      window.open(urls.google, '_blank')
    }

    localStorage.setItem('nav-preference', 'native')
  }

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
      )}

      <Button
        variant="outline"
        className="w-full justify-start gap-3"
        onClick={openNativeMaps}
      >
        <Navigation className="size-4 text-primary" />
        <span className="flex-1 text-left">Navigate to Address</span>
        <ExternalLink className="size-3 text-muted-foreground" />
      </Button>
    </div>
  )
}
