"use client"

import { useRef, useEffect, useState } from "react"
import Map, { Marker, Source, Layer, type MapRef } from "react-map-gl/mapbox"
import { Package, MapPin, Truck } from "lucide-react"
import { T } from "@/lib/driver-theme"
import "mapbox-gl/dist/mapbox-gl.css"

interface DriverMapProps {
  driverLat?: number | null
  driverLng?: number | null
  originLat?: number | null
  originLng?: number | null
  originCity?: string
  destLat?: number | null
  destLng?: number | null
  destCity?: string
  phase: string
}

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

export function DriverMap({
  driverLat,
  driverLng,
  originLat,
  originLng,
  originCity,
  destLat,
  destLng,
  destCity,
  phase,
}: DriverMapProps) {
  const mapRef = useRef<MapRef>(null)
  const [loaded, setLoaded] = useState(false)

  const hasDriver = driverLat != null && driverLng != null
  const hasOrigin = originLat != null && originLng != null
  const hasDest = destLat != null && destLng != null
  const hasRoute = hasOrigin && hasDest

  // Fit bounds to all visible points
  useEffect(() => {
    if (!loaded || !mapRef.current) return

    const points: [number, number][] = []
    if (hasDriver) points.push([driverLng!, driverLat!])
    if (hasOrigin) points.push([originLng!, originLat!])
    if (hasDest) points.push([destLng!, destLat!])

    if (points.length === 0) return

    if (points.length === 1) {
      mapRef.current.flyTo({
        center: points[0],
        zoom: 14,
        duration: 800,
      })
    } else {
      const lngs = points.map((p) => p[0])
      const lats = points.map((p) => p[1])

      mapRef.current.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: { top: 80, bottom: 280, left: 50, right: 50 }, duration: 800 }
      )
    }
  }, [loaded, driverLat, driverLng, originLat, originLng, destLat, destLng, hasDriver, hasOrigin, hasDest])

  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "pk.placeholder") {
    return null
  }

  // Build route line through all known points
  const routeCoords: [number, number][] = []
  if (hasOrigin) routeCoords.push([originLng!, originLat!])
  if (hasDriver && hasRoute) routeCoords.push([driverLng!, driverLat!])
  if (hasDest) routeCoords.push([destLng!, destLat!])

  const routeGeoJSON: GeoJSON.Feature<GeoJSON.Geometry> | null =
    routeCoords.length >= 2
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: routeCoords },
        }
      : null

  // Center on driver or route midpoint or USA center
  const centerLng = hasDriver
    ? driverLng!
    : hasRoute
      ? (originLng! + destLng!) / 2
      : -98.5
  const centerLat = hasDriver
    ? driverLat!
    : hasRoute
      ? (originLat! + destLat!) / 2
      : 39.8

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle="mapbox://styles/mapbox/dark-v11"
        initialViewState={{
          longitude: centerLng,
          latitude: centerLat,
          zoom: hasRoute ? 5 : 14,
        }}
        style={{ width: "100%", height: "100%" }}
        interactive={true}
        onLoad={() => setLoaded(true)}
        attributionControl={false}
      >
        {/* Route glow layer (wide, soft) */}
        {routeGeoJSON && (
          <Source id="route-glow" type="geojson" data={routeGeoJSON}>
            <Layer
              id="route-glow-line"
              type="line"
              paint={{
                "line-color": T.accent,
                "line-width": 10,
                "line-opacity": 0.08,
                "line-blur": 6,
              }}
            />
          </Source>
        )}

        {/* Route main line */}
        {routeGeoJSON && (
          <Source id="route" type="geojson" data={routeGeoJSON}>
            <Layer
              id="route-line"
              type="line"
              paint={{
                "line-color": T.accent,
                "line-width": 3,
                "line-opacity": 0.65,
              }}
            />
          </Source>
        )}

        {/* Origin / Pickup marker — always shown when coords exist */}
        {hasOrigin && (
          <Marker longitude={originLng!} latitude={originLat!} anchor="bottom">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #60a5fa, #3b82f6)",
                  border: "2.5px solid rgba(255,255,255,0.9)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 2px 12px rgba(59,130,246,0.45), 0 0 0 3px rgba(59,130,246,0.12)",
                }}
              >
                <Package size={15} color="#fff" strokeWidth={2.5} />
              </div>
              <div
                style={{
                  width: 2,
                  height: 8,
                  background: "linear-gradient(to bottom, #3b82f6, transparent)",
                }}
              />
              {originCity && (
                <span
                  style={{
                    marginTop: 1,
                    fontSize: 10,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.85)",
                    textShadow: "0 1px 6px rgba(0,0,0,0.9)",
                    whiteSpace: "nowrap",
                    letterSpacing: "0.01em",
                  }}
                >
                  {originCity}
                </span>
              )}
            </div>
          </Marker>
        )}

        {/* Destination / Dropoff marker — always shown when coords exist */}
        {hasDest && (
          <Marker longitude={destLng!} latitude={destLat!} anchor="bottom">
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #34d399, #059669)",
                  border: "2.5px solid rgba(255,255,255,0.9)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 2px 12px rgba(52,211,153,0.45), 0 0 0 3px rgba(52,211,153,0.12)",
                }}
              >
                <MapPin size={15} color="#fff" strokeWidth={2.5} />
              </div>
              <div
                style={{
                  width: 2,
                  height: 8,
                  background: "linear-gradient(to bottom, #059669, transparent)",
                }}
              />
              {destCity && (
                <span
                  style={{
                    marginTop: 1,
                    fontSize: 10,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.85)",
                    textShadow: "0 1px 6px rgba(0,0,0,0.9)",
                    whiteSpace: "nowrap",
                    letterSpacing: "0.01em",
                  }}
                >
                  {destCity}
                </span>
              )}
            </div>
          </Marker>
        )}

        {/* Driver position marker */}
        {hasDriver && (
          <Marker longitude={driverLng!} latitude={driverLat!} anchor="center">
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {/* Outer pulse ring */}
              <div
                style={{
                  position: "absolute",
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  border: `2px solid ${T.accent}`,
                  opacity: 0.2,
                  animation: "driverPing 2s ease-in-out infinite",
                }}
              />
              {/* Inner glow */}
              <div
                style={{
                  position: "absolute",
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  background: T.accent,
                  opacity: 0.1,
                }}
              />
              {/* Main driver dot */}
              <div
                style={{
                  position: "relative",
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: T.accentGradient,
                  border: "3px solid rgba(255,255,255,0.95)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: `0 4px 20px ${T.accentGlow}, 0 0 0 4px rgba(59,130,246,0.08)`,
                  zIndex: 1,
                }}
              >
                <Truck size={18} color="#fff" strokeWidth={2.5} />
              </div>
            </div>
          </Marker>
        )}
      </Map>

      {/* Subtle branding watermark */}
      <div
        style={{
          position: "absolute",
          bottom: 8,
          right: 12,
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "rgba(8,13,20,0.6)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.06)",
          zIndex: 5,
        }}
      >
        <img src="/icons/icon-192.png" alt="" width={12} height={12} style={{ borderRadius: 3 }} />
        <span
          style={{
            color: "rgba(255,255,255,0.35)",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: ".1em",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          MYRA
        </span>
      </div>
    </div>
  )
}
