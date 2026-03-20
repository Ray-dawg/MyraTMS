"use client"

import { useRef, useEffect, useState, useCallback } from "react"
import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MapSidebar, type MapLoad, type MapFilters, type MapSummary } from "@/components/map-sidebar"

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ""

const ALL_STATUSES = ["Booked", "Dispatched", "In Transit", "Delivered", "Invoiced"]

function buildGeoJSON(loads: MapLoad[], filters: MapFilters): GeoJSON.FeatureCollection {
  let filtered = loads

  // Status filter
  if (filters.statuses.length > 0 && filters.statuses.length < ALL_STATUSES.length) {
    filtered = filtered.filter((l) => filters.statuses.includes(l.status))
  }

  // Equipment filter
  if (filters.equipment) {
    filtered = filtered.filter((l) =>
      l.equipment?.toLowerCase().includes(filters.equipment.toLowerCase())
    )
  }

  // Search filter
  if (filters.search) {
    const q = filters.search.toLowerCase()
    filtered = filtered.filter(
      (l) =>
        l.id.toLowerCase().includes(q) ||
        (l.reference_number && l.reference_number.toLowerCase().includes(q)) ||
        (l.shipper_name && l.shipper_name.toLowerCase().includes(q)) ||
        (l.carrier_name && l.carrier_name.toLowerCase().includes(q)) ||
        (l.origin_city && l.origin_city.toLowerCase().includes(q)) ||
        (l.dest_city && l.dest_city.toLowerCase().includes(q))
    )
  }

  const features: GeoJSON.Feature[] = []
  for (const load of filtered) {
    // Determine pin position
    let lng: number | null = null
    let lat: number | null = null

    if (load.status === "In Transit" && load.current_lat != null && load.current_lng != null) {
      lat = Number(load.current_lat)
      lng = Number(load.current_lng)
    } else if (load.status === "Delivered" || load.status === "Invoiced") {
      lat = load.dest_lat != null ? Number(load.dest_lat) : null
      lng = load.dest_lng != null ? Number(load.dest_lng) : null
    }

    // Fall back to origin
    if (lat == null || lng == null) {
      lat = load.origin_lat != null ? Number(load.origin_lat) : null
      lng = load.origin_lng != null ? Number(load.origin_lng) : null
    }

    if (lat == null || lng == null) continue

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        id: load.id,
        reference_number: load.reference_number || load.id,
        status: load.status,
        has_exception: !!load.has_exception,
        shipper_name: load.shipper_name || "",
        carrier_name: load.carrier_name || "",
        driver_name: load.driver_name || "",
        origin_city: load.origin_city || load.origin?.split(",")[0] || "",
        dest_city: load.dest_city || load.destination?.split(",")[0] || "",
        current_eta: load.current_eta || "",
        equipment: load.equipment || "",
      },
    })
  }

  return { type: "FeatureCollection", features }
}

function buildRouteLines(loads: MapLoad[], filters: MapFilters): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  let filtered = loads.filter((l) => l.status === "In Transit")

  if (filters.statuses.length > 0 && !filters.statuses.includes("In Transit")) {
    return { type: "FeatureCollection", features: [] }
  }

  if (filters.search) {
    const q = filters.search.toLowerCase()
    filtered = filtered.filter(
      (l) =>
        l.id.toLowerCase().includes(q) ||
        (l.reference_number && l.reference_number.toLowerCase().includes(q)) ||
        (l.shipper_name && l.shipper_name.toLowerCase().includes(q)) ||
        (l.carrier_name && l.carrier_name.toLowerCase().includes(q))
    )
  }

  for (const load of filtered) {
    const oLat = load.origin_lat != null ? Number(load.origin_lat) : null
    const oLng = load.origin_lng != null ? Number(load.origin_lng) : null
    const cLat = load.current_lat != null ? Number(load.current_lat) : null
    const cLng = load.current_lng != null ? Number(load.current_lng) : null
    const dLat = load.dest_lat != null ? Number(load.dest_lat) : null
    const dLng = load.dest_lng != null ? Number(load.dest_lng) : null

    if (oLat == null || oLng == null || cLat == null || cLng == null) continue

    // Completed segment: origin → current
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [[oLng, oLat], [cLng, cLat]],
      },
      properties: { segment: "completed" },
    })

    // Remaining segment: current → destination
    if (dLat != null && dLng != null) {
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[cLng, cLat], [dLng, dLat]],
        },
        properties: { segment: "remaining" },
      })
    }
  }

  return { type: "FeatureCollection", features }
}

export default function GlobalLoadMap() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)

  const [loads, setLoads] = useState<MapLoad[]>([])
  const [summary, setSummary] = useState<MapSummary>({
    total: 0, booked: 0, dispatched: 0, in_transit: 0, delivered: 0, exceptions: 0,
  })
  const [filters, setFilters] = useState<MapFilters>({
    statuses: [...ALL_STATUSES],
    equipment: "",
    search: "",
  })
  const [selectedLoad, setSelectedLoad] = useState<MapLoad | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Fetch loads from API
  const fetchLoads = useCallback(async () => {
    try {
      const res = await fetch("/api/loads/map")
      if (!res.ok) return
      const data = await res.json()
      setLoads(data.loads || [])
      setSummary(data.summary || { total: 0, booked: 0, dispatched: 0, in_transit: 0, delivered: 0, exceptions: 0 })
      setLastUpdated(new Date())
    } catch {
      // silently fail
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchLoads()
  }, [fetchLoads])

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(fetchLoads, 60_000)
    return () => clearInterval(interval)
  }, [fetchLoads])

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-79.5, 44.0],
      zoom: 6,
      attributionControl: false,
    })

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right")

    map.on("load", () => {
      // Add loads source with clustering
      map.addSource("loads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      })

      // Add route lines source
      map.addSource("route-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      })

      // --- Route line layers ---
      map.addLayer({
        id: "route-completed",
        type: "line",
        source: "route-lines",
        filter: ["==", ["get", "segment"], "completed"],
        paint: {
          "line-color": "#4CAF50",
          "line-width": 2,
          "line-opacity": 0.7,
        },
      })

      map.addLayer({
        id: "route-remaining",
        type: "line",
        source: "route-lines",
        filter: ["==", ["get", "segment"], "remaining"],
        paint: {
          "line-color": "#666666",
          "line-width": 1.5,
          "line-opacity": 0.5,
          "line-dasharray": [4, 4],
        },
      })

      // --- Cluster circle layer ---
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "loads",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#3b82f6",
          "circle-radius": [
            "step",
            ["get", "point_count"],
            15,   // radius for count < 10
            10, 20, // radius 20 for count >= 10
            50, 25, // radius 25 for count >= 50
          ],
          "circle-opacity": 0.85,
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(59, 130, 246, 0.3)",
        },
      })

      // --- Cluster count label ---
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "loads",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#ffffff",
        },
      })

      // --- Exception pins (red, rendered on top) ---
      map.addLayer({
        id: "exception-pins",
        type: "circle",
        source: "loads",
        filter: ["all",
          ["!", ["has", "point_count"]],
          ["==", ["get", "has_exception"], true],
        ],
        paint: {
          "circle-color": "#F44336",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(244, 67, 54, 0.3)",
        },
      })

      // --- Normal load pins (below exception pins) ---
      map.addLayer({
        id: "load-pins",
        type: "circle",
        source: "loads",
        filter: ["all",
          ["!", ["has", "point_count"]],
          ["!=", ["get", "has_exception"], true],
        ],
        paint: {
          "circle-color": [
            "match", ["get", "status"],
            "Booked", "#9E9E9E",
            "Dispatched", "#FF9800",
            "In Transit", "#4CAF50",
            "Delivered", "#2E7D32",
            "Invoiced", "#2E7D32",
            "#9E9E9E",
          ],
          "circle-radius": 6,
          "circle-stroke-width": 2,
          "circle-stroke-color": [
            "match", ["get", "status"],
            "Booked", "rgba(158, 158, 158, 0.3)",
            "Dispatched", "rgba(255, 152, 0, 0.3)",
            "In Transit", "rgba(76, 175, 80, 0.3)",
            "Delivered", "rgba(46, 125, 50, 0.3)",
            "Invoiced", "rgba(46, 125, 50, 0.3)",
            "rgba(158, 158, 158, 0.3)",
          ],
        },
      })

      // --- Click: expand clusters ---
      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })
        if (!features.length) return
        const clusterId = features[0].properties?.cluster_id
        const source = map.getSource("loads") as mapboxgl.GeoJSONSource
        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err || zoom == null) return
          const geometry = features[0].geometry
          if (geometry.type !== "Point") return
          map.easeTo({
            center: geometry.coordinates as [number, number],
            zoom: zoom + 1,
          })
        })
      })

      // --- Click: load pins ---
      map.on("click", "load-pins", (e) => {
        if (!e.features?.length) return
        const props = e.features[0].properties
        if (props) {
          // Dispatch custom event so React can handle it
          window.dispatchEvent(
            new CustomEvent("map-load-click", { detail: props.id })
          )
        }
      })

      map.on("click", "exception-pins", (e) => {
        if (!e.features?.length) return
        const props = e.features[0].properties
        if (props) {
          window.dispatchEvent(
            new CustomEvent("map-load-click", { detail: props.id })
          )
        }
      })

      // --- Cursor changes ---
      for (const layer of ["clusters", "load-pins", "exception-pins"]) {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer" })
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = "" })
      }

      setMapLoaded(true)
    })

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // Listen for pin click events from the map
  useEffect(() => {
    const handler = (e: Event) => {
      const loadId = (e as CustomEvent).detail
      const found = loads.find((l) => l.id === loadId)
      if (found) setSelectedLoad(found)
    }
    window.addEventListener("map-load-click", handler)
    return () => window.removeEventListener("map-load-click", handler)
  }, [loads])

  // Update GeoJSON data when loads or filters change
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return
    const map = mapRef.current

    const loadsSource = map.getSource("loads") as mapboxgl.GeoJSONSource | undefined
    const routeSource = map.getSource("route-lines") as mapboxgl.GeoJSONSource | undefined

    if (loadsSource) {
      loadsSource.setData(buildGeoJSON(loads, filters))
    }
    if (routeSource) {
      routeSource.setData(buildRouteLines(loads, filters))
    }
  }, [loads, filters, mapLoaded])

  // Resize map when sidebar toggles
  useEffect(() => {
    if (!mapRef.current) return
    // Small delay for CSS transition
    const timeout = setTimeout(() => mapRef.current?.resize(), 250)
    return () => clearTimeout(timeout)
  }, [sidebarOpen])

  return (
    <div className="flex" style={{ height: "calc(100vh - 64px)" }}>
      {/* Sidebar */}
      <div
        className="shrink-0 overflow-hidden transition-all duration-200"
        style={{ width: sidebarOpen ? 300 : 0 }}
      >
        {sidebarOpen && (
          <MapSidebar
            loads={loads}
            filters={filters}
            onFilterChange={setFilters}
            selectedLoad={selectedLoad}
            onSelectLoad={setSelectedLoad}
            summary={summary}
            lastUpdated={lastUpdated}
          />
        )}
      </div>

      {/* Map */}
      <div className="relative flex-1">
        <div ref={mapContainer} className="h-full w-full" />

        {/* Toggle sidebar button */}
        <Button
          variant="secondary"
          size="icon"
          className="absolute top-3 left-3 z-10 h-8 w-8 shadow-md"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeftOpen className="h-4 w-4" />
          )}
        </Button>

        {/* Last updated badge */}
        {lastUpdated && (
          <div className="absolute bottom-3 right-3 z-10 rounded-md bg-background/80 backdrop-blur-sm px-2.5 py-1 text-[10px] text-muted-foreground border border-border shadow-sm">
            Updated {formatTimeAgo(lastUpdated)}
          </div>
        )}
      </div>
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}
