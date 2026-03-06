"use client"

import { useRef, useEffect, useState } from "react"
import Map, { Marker, Source, Layer, type MapRef } from "react-map-gl/mapbox"
import { useTheme } from "next-themes"
import { MapPin, Navigation, Truck } from "lucide-react"
import "mapbox-gl/dist/mapbox-gl.css"

interface LoadMapProps {
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  currentLat?: number | null
  currentLng?: number | null
  height?: number
  interactive?: boolean
}

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

export function LoadMap({
  originLat,
  originLng,
  destLat,
  destLng,
  currentLat,
  currentLng,
  height = 320,
  interactive = true,
}: LoadMapProps) {
  const mapRef = useRef<MapRef>(null)
  const { resolvedTheme } = useTheme()
  const [loaded, setLoaded] = useState(false)

  const mapStyle =
    resolvedTheme === "dark"
      ? "mapbox://styles/mapbox/dark-v11"
      : "mapbox://styles/mapbox/light-v11"

  const hasCurrentPos = currentLat != null && currentLng != null

  // Fit bounds on load
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
      { padding: 60, duration: 800 }
    )
  }, [loaded, originLat, originLng, destLat, destLng, currentLat, currentLng, hasCurrentPos])

  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "pk.placeholder") {
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-secondary/30 text-muted-foreground text-xs"
        style={{ height }}
      >
        Map unavailable — set NEXT_PUBLIC_MAPBOX_TOKEN
      </div>
    )
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
    <div className="rounded-lg overflow-hidden" style={{ height }}>
      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        mapStyle={mapStyle}
        initialViewState={{
          longitude: (originLng + destLng) / 2,
          latitude: (originLat + destLat) / 2,
          zoom: 5,
        }}
        style={{ width: "100%", height: "100%" }}
        interactive={interactive}
        onLoad={() => setLoaded(true)}
        attributionControl={false}
      >
        {/* Route line */}
        <Source id="route" type="geojson" data={routeGeoJSON}>
          <Layer
            id="route-line"
            type="line"
            paint={{
              "line-color": resolvedTheme === "dark" ? "#60a5fa" : "#3b82f6",
              "line-width": 3,
              "line-dasharray": [2, 2],
              "line-opacity": 0.7,
            }}
          />
        </Source>

        {/* Origin marker */}
        <Marker longitude={originLng} latitude={originLat} anchor="center">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-success/20 border-2 border-success shadow-md">
            <MapPin className="h-3.5 w-3.5 text-success" />
          </div>
        </Marker>

        {/* Destination marker */}
        <Marker longitude={destLng} latitude={destLat} anchor="center">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-destructive/20 border-2 border-destructive shadow-md">
            <Navigation className="h-3.5 w-3.5 text-destructive" />
          </div>
        </Marker>

        {/* Current position marker */}
        {hasCurrentPos && (
          <Marker longitude={currentLng!} latitude={currentLat!} anchor="center">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-10 h-10 rounded-full bg-accent/20 animate-ping" />
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-accent border-2 border-white shadow-lg z-10">
                <Truck className="h-4 w-4 text-white" />
              </div>
            </div>
          </Marker>
        )}
      </Map>
    </div>
  )
}
