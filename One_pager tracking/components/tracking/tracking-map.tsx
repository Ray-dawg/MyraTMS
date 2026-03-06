"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import dynamic from "next/dynamic"
import { Navigation, Maximize2, Minimize2, GripHorizontal } from "lucide-react"

const TrackingMapInner = dynamic(
  () => import("./tracking-map-inner").then((mod) => mod.TrackingMapInner),
  { ssr: false }
)

interface TrackingMapProps {
  originCity: string
  destinationCity: string
  progress: number
  currentCity: string
  originLat?: number | null
  originLng?: number | null
  destLat?: number | null
  destLng?: number | null
  currentLat?: number | null
  currentLng?: number | null
}

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
const MIN_HEIGHT = 200
const DEFAULT_HEIGHT = 320
const EXPANDED_HEIGHT = 520
const MAX_HEIGHT = 700

function bezier(
  ax: number, ay: number,
  cx: number, cy: number,
  bx: number, by: number,
  t: number
) {
  const x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t ** 2 * bx
  const y = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t ** 2 * by
  return { x, y }
}

function CanvasFallback({
  originCity,
  destinationCity,
  progress,
  height,
}: {
  originCity: string
  destinationCity: string
  progress: number
  height: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 800, h: height })

  useEffect(() => {
    function update() {
      if (containerRef.current) {
        setDims({ w: containerRef.current.offsetWidth, h: height })
      }
    }
    update()
    const ro = new ResizeObserver(update)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [height])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    const W = dims.w
    const H = height

    const ox = W * 0.1, oy = H * 0.58
    const dx = W * 0.9, dy = H * 0.42
    const cx = (ox + dx) / 2, cy = Math.min(oy, dy) - H * 0.22

    const bg = ctx.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.4, W * 0.7)
    bg.addColorStop(0, "#111b30")
    bg.addColorStop(1, "#0a0f1e")
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    ctx.fillStyle = "rgba(255,255,255,0.025)"
    for (let gx = 20; gx < W; gx += 32) {
      for (let gy = 20; gy < H; gy += 32) {
        ctx.beginPath()
        ctx.arc(gx, gy, 0.6, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.setLineDash([4, 8])
    ctx.strokeStyle = "rgba(255,255,255,0.07)"
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(ox, oy)
    ctx.quadraticCurveTo(cx, cy, dx, dy)
    ctx.stroke()
    ctx.setLineDash([])

    const steps = 150
    const traveledSteps = Math.floor(progress * steps)
    if (traveledSteps > 1) {
      ctx.shadowColor = "#e8601f"
      ctx.shadowBlur = 28
      ctx.strokeStyle = "rgba(232,96,31,0.25)"
      ctx.lineWidth = 8
      ctx.lineCap = "round"
      ctx.beginPath()
      const p0 = bezier(ox, oy, cx, cy, dx, dy, 0)
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i <= traveledSteps; i++) {
        const pt = bezier(ox, oy, cx, cy, dx, dy, i / steps)
        ctx.lineTo(pt.x, pt.y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0

      ctx.strokeStyle = "#e8601f"
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i <= traveledSteps; i++) {
        const pt = bezier(ox, oy, cx, cy, dx, dy, i / steps)
        ctx.lineTo(pt.x, pt.y)
      }
      ctx.stroke()
      ctx.lineCap = "butt"
    }

    ctx.strokeStyle = "rgba(255,255,255,0.15)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(ox, oy, 14, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = "#ffffff"
    ctx.shadowColor = "#ffffff"
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(ox, oy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    ctx.font = "600 11px Inter, system-ui, sans-serif"
    ctx.textAlign = "center"
    ctx.fillStyle = "rgba(255,255,255,0.9)"
    ctx.fillText(originCity, ox, oy + 30)
    ctx.font = "500 9px Inter, system-ui, sans-serif"
    ctx.fillStyle = "rgba(255,255,255,0.35)"
    ctx.fillText("ORIGIN", ox, oy + 42)

    ctx.strokeStyle = "rgba(232,96,31,0.3)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(dx, dy, 16, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = "rgba(232,96,31,0.12)"
    ctx.beginPath()
    ctx.arc(dx, dy, 24, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = "#e8601f"
    ctx.shadowColor = "#e8601f"
    ctx.shadowBlur = 20
    ctx.beginPath()
    ctx.arc(dx, dy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    ctx.font = "600 11px Inter, system-ui, sans-serif"
    ctx.textAlign = "center"
    ctx.fillStyle = "rgba(255,255,255,0.9)"
    ctx.fillText(destinationCity, dx, dy + 32)
    ctx.font = "500 9px Inter, system-ui, sans-serif"
    ctx.fillStyle = "rgba(255,255,255,0.35)"
    ctx.fillText("DESTINATION", dx, dy + 44)

    if (progress > 0.01 && progress < 0.99) {
      const truck = bezier(ox, oy, cx, cy, dx, dy, progress)
      const tNext = Math.min(progress + 0.008, 1)
      const pNext = bezier(ox, oy, cx, cy, dx, dy, tNext)
      const angle = Math.atan2(pNext.y - truck.y, pNext.x - truck.x)

      ctx.save()
      ctx.translate(truck.x, truck.y)
      ctx.rotate(angle)

      ctx.shadowColor = "#e8601f"
      ctx.shadowBlur = 30
      ctx.fillStyle = "#e8601f"
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0

      ctx.fillStyle = "#ffffff"
      ctx.beginPath()
      ctx.arc(0, 0, 11, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = "#e8601f"
      ctx.beginPath()
      ctx.arc(0, 0, 8, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = "#ffffff"
      ctx.beginPath()
      ctx.moveTo(-3, -3)
      ctx.lineTo(4, 0)
      ctx.lineTo(-3, 3)
      ctx.closePath()
      ctx.fill()

      ctx.restore()
    }
  }, [dims, height, progress, originCity, destinationCity])

  useEffect(() => { draw() }, [draw])

  return (
    <div ref={containerRef} className="relative w-full" style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}

export function TrackingMap({
  originCity,
  destinationCity,
  progress,
  currentCity,
  originLat,
  originLng,
  destLat,
  destLng,
  currentLat,
  currentLng,
}: TrackingMapProps) {
  const [mapHeight, setMapHeight] = useState(DEFAULT_HEIGHT)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const hasCoords =
    originLat != null &&
    originLng != null &&
    destLat != null &&
    destLng != null

  const hasMapbox = MAPBOX_TOKEN && MAPBOX_TOKEN !== "pk.placeholder"
  const useMapbox = hasCoords && hasMapbox

  const handleDragStart = useCallback((clientY: number) => {
    setIsDragging(true)
    dragStartY.current = clientY
    dragStartHeight.current = mapHeight
  }, [mapHeight])

  useEffect(() => {
    if (!isDragging) return

    function handleMove(e: MouseEvent | TouchEvent) {
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY
      const delta = clientY - dragStartY.current
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragStartHeight.current + delta))
      setMapHeight(newHeight)
      setIsExpanded(newHeight >= EXPANDED_HEIGHT)
    }

    function handleEnd() {
      setIsDragging(false)
    }

    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleEnd)
    window.addEventListener("touchmove", handleMove)
    window.addEventListener("touchend", handleEnd)

    return () => {
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleEnd)
      window.removeEventListener("touchmove", handleMove)
      window.removeEventListener("touchend", handleEnd)
    }
  }, [isDragging])

  function toggleExpand() {
    if (isExpanded) {
      setMapHeight(DEFAULT_HEIGHT)
      setIsExpanded(false)
    } else {
      setMapHeight(EXPANDED_HEIGHT)
      setIsExpanded(true)
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card">
      {/* Expand/collapse toggle */}
      <button
        onClick={toggleExpand}
        className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/80 px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground backdrop-blur-lg transition-all hover:border-primary/30 hover:text-foreground"
        aria-label={isExpanded ? "Collapse map" : "Expand map"}
      >
        {isExpanded ? (
          <Minimize2 className="h-3 w-3" />
        ) : (
          <Maximize2 className="h-3 w-3" />
        )}
        <span className="hidden sm:inline">{isExpanded ? "Collapse" : "Expand"}</span>
      </button>

      {/* Map content */}
      <div
        className="relative w-full transition-[height] duration-300 ease-out"
        style={{ height: `${mapHeight}px` }}
      >
        {useMapbox ? (
          <TrackingMapInner
            originLat={originLat!}
            originLng={originLng!}
            originCity={originCity}
            destLat={destLat!}
            destLng={destLng!}
            destinationCity={destinationCity}
            currentLat={currentLat}
            currentLng={currentLng}
            height={mapHeight}
          />
        ) : (
          <CanvasFallback
            originCity={originCity}
            destinationCity={destinationCity}
            progress={progress}
            height={mapHeight}
          />
        )}
      </div>

      {/* Floating location pill */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
        <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card/90 px-4 py-2 shadow-2xl backdrop-blur-xl">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-live-pulse" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <Navigation className="h-3 w-3 text-primary" />
          <span className="text-xs font-semibold text-foreground">{currentCity}</span>
          <span className="text-[10px] text-muted-foreground">- Live</span>
        </div>
      </div>

      {/* Drag-to-resize handle */}
      <div
        onMouseDown={(e) => handleDragStart(e.clientY)}
        onTouchStart={(e) => handleDragStart(e.touches[0].clientY)}
        className={`flex h-6 w-full cursor-row-resize items-center justify-center border-t border-border/60 transition-colors ${isDragging ? "bg-primary/10" : "bg-card hover:bg-secondary/60"}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize map"
      >
        <GripHorizontal className={`h-3.5 w-3.5 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground/50"}`} />
      </div>
    </div>
  )
}
