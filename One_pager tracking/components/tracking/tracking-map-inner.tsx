"use client"

import { useRef, useEffect, useState } from "react"
import Map, { Marker, Source, Layer, type MapRef } from "react-map-gl/mapbox"
import { useTheme } from "@/lib/theme-context"
import "mapbox-gl/dist/mapbox-gl.css"

interface TrackingMapInnerProps {
  originLat: number
  originLng: number
  originCity: string
  destLat: number
  destLng: number
  destinationCity: string
  currentLat?: number | null
  currentLng?: number | null
  height: number
}

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

export function TrackingMapInner({
  originLat,
  originLng,
  originCity,
  destLat,
  destLng,
  destinationCity,
  currentLat,
  currentLng,
  height,
}: TrackingMapInnerProps) {
  const mapRef = useRef<MapRef>(null)
  const { theme } = useTheme()
  const [loaded, setLoaded] = useState(false)

  const isDark = theme === "dark-orange"
  const mapStyle = isDark
    ? "mapbox://styles/mapbox/dark-v11"
    : "mapbox://styles/mapbox/light-v11"

  const hasCurrentPos = currentLat != null && currentLng != null

  useEffect(() => {
    if (!loaded || !mapRef.current) return

    const points: [number, number][] = [
      [originLng, originLat],
      [destLng, destLat],
    ]
    if (hasCurrentPos) {
      points.push([currentLng!, currentLat!])
    }

    const lngs = points.map((p) => p[0])
    const lats = points.map((p) => p[1])

    mapRef.current.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 50, duration: 800 }
    )
  }, [loaded, originLat, originLng, destLat, destLng, currentLat, currentLng, hasCurrentPos])

  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "pk.placeholder") {
    return null // fallback handled by parent
  }

  const routeGeoJSON: GeoJSON.Feature<GeoJSON.Geometry> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: hasCurrentPos
        ? [
            [originLng, originLat],
            [currentLng!, currentLat!],
            [destLng, destLat],
          ]
        : [
            [originLng, originLat],
            [destLng, destLat],
          ],
    },
  }

  return (
    <Map
      ref={mapRef}
      mapboxAccessToken={MAPBOX_TOKEN}
      mapStyle={mapStyle}
      initialViewState={{
        longitude: (originLng + destLng) / 2,
        latitude: (originLat + destLat) / 2,
        zoom: 5,
      }}
      style={{ width: "100%", height }}
      interactive={false}
      onLoad={() => setLoaded(true)}
      attributionControl={false}
    >
      {/* Route line */}
      <Source id="route" type="geojson" data={routeGeoJSON}>
        <Layer
          id="route-line"
          type="line"
          paint={{
            "line-color": "#e8601f",
            "line-width": 3,
            "line-dasharray": [2, 2],
            "line-opacity": 0.8,
          }}
        />
      </Source>

      {/* Origin marker */}
      <Marker longitude={originLng} latitude={originLat} anchor="center">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)",
              border: "2px solid #fff",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          />
          <span
            style={{
              marginTop: 4,
              fontSize: 10,
              fontWeight: 600,
              color: isDark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.8)",
              textShadow: isDark ? "0 1px 4px rgba(0,0,0,0.8)" : "0 1px 2px rgba(255,255,255,0.8)",
              whiteSpace: "nowrap",
            }}
          >
            {originCity}
          </span>
        </div>
      </Marker>

      {/* Destination marker */}
      <Marker longitude={destLng} latitude={destLat} anchor="center">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "#e8601f",
              border: "2px solid #fff",
              boxShadow: "0 2px 8px rgba(232,96,31,0.4)",
            }}
          />
          <span
            style={{
              marginTop: 4,
              fontSize: 10,
              fontWeight: 600,
              color: isDark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.8)",
              textShadow: isDark ? "0 1px 4px rgba(0,0,0,0.8)" : "0 1px 2px rgba(255,255,255,0.8)",
              whiteSpace: "nowrap",
            }}
          >
            {destinationCity}
          </span>
        </div>
      </Marker>

      {/* Current position */}
      {hasCurrentPos && (
        <Marker longitude={currentLng!} latitude={currentLat!} anchor="center">
          <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div
              style={{
                position: "absolute",
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "rgba(232,96,31,0.25)",
                animation: "pulse 2s ease-in-out infinite",
              }}
            />
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#e8601f",
                border: "3px solid #fff",
                boxShadow: "0 2px 8px rgba(232,96,31,0.5)",
                zIndex: 1,
              }}
            />
          </div>
        </Marker>
      )}
    </Map>
  )
}
