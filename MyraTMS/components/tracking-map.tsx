"use client"

interface TrackingPosition {
  loadId: string
  carrier: string
  origin: string
  destination: string
  currentLat: number
  currentLng: number
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  speed: number
  heading: string
  lastUpdate: string
  eta: string
  status: string
  progressPercent: number
  nextCheckCall: string
  driver: string
  driverPhone: string
}

const statusColors: Record<string, string> = {
  "On Schedule": "#22c55e",
  Delayed: "#f59e0b",
  "Off Route": "#ef4444",
  "No Signal": "#6b7280",
}

// Approximate US coordinate bounds for mapping to SVG
const US_BOUNDS = { minLat: 25, maxLat: 49, minLng: -125, maxLng: -67 }

function toSvg(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng - US_BOUNDS.minLng) / (US_BOUNDS.maxLng - US_BOUNDS.minLng)) * 900 + 50
  const y = ((US_BOUNDS.maxLat - lat) / (US_BOUNDS.maxLat - US_BOUNDS.minLat)) * 450 + 25
  return { x, y }
}

export function TrackingMap({
  positions,
  selectedLoadId,
  onSelect,
}: {
  positions: TrackingPosition[]
  selectedLoadId: string | null
  onSelect: (loadId: string) => void
}) {
  return (
    <div className="relative w-full rounded-lg border border-border bg-secondary/10 overflow-hidden" style={{ aspectRatio: "2/1" }}>
      <svg viewBox="0 0 1000 500" className="w-full h-full">
        {/* Background grid */}
        <defs>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="currentColor" strokeOpacity="0.04" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="1000" height="500" fill="url(#grid)" />

        {/* US outline (simplified) */}
        <path
          d="M120,120 L180,100 L250,105 L350,95 L420,90 L480,88 L520,92 L580,88 L640,95 L700,100 L760,95 L820,110 L860,130 L870,160 L880,200 L870,240 L860,280 L830,310 L790,340 L750,360 L700,370 L660,380 L620,390 L580,385 L540,380 L500,370 L460,360 L420,350 L380,340 L340,330 L300,320 L260,310 L220,300 L180,280 L150,250 L130,220 L120,180 Z"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeWidth="1"
        />

        {/* Route lines */}
        {positions.map((p) => {
          const origin = toSvg(p.originLat, p.originLng)
          const dest = toSvg(p.destLat, p.destLng)
          const current = toSvg(p.currentLat, p.currentLng)
          const isSelected = selectedLoadId === p.loadId
          return (
            <g key={p.loadId}>
              {/* Full route dashed */}
              <line
                x1={origin.x} y1={origin.y} x2={dest.x} y2={dest.y}
                stroke={statusColors[p.status]}
                strokeWidth={isSelected ? 2 : 1}
                strokeOpacity={isSelected ? 0.5 : 0.15}
                strokeDasharray="6,4"
              />
              {/* Completed segment solid */}
              <line
                x1={origin.x} y1={origin.y} x2={current.x} y2={current.y}
                stroke={statusColors[p.status]}
                strokeWidth={isSelected ? 2.5 : 1.5}
                strokeOpacity={isSelected ? 0.8 : 0.4}
              />
              {/* Origin dot */}
              <circle cx={origin.x} cy={origin.y} r={isSelected ? 4 : 3} fill="none" stroke={statusColors[p.status]} strokeWidth="1.5" strokeOpacity={isSelected ? 0.8 : 0.3} />
              {/* Destination dot */}
              <circle cx={dest.x} cy={dest.y} r={isSelected ? 4 : 3} fill={statusColors[p.status]} fillOpacity={isSelected ? 0.3 : 0.15} stroke={statusColors[p.status]} strokeWidth="1.5" strokeOpacity={isSelected ? 0.8 : 0.3} />
              {/* Current position (truck) */}
              <g className="cursor-pointer" onClick={() => onSelect(p.loadId)}>
                <circle cx={current.x} cy={current.y} r={isSelected ? 10 : 7} fill={statusColors[p.status]} fillOpacity={0.15} stroke={statusColors[p.status]} strokeWidth={isSelected ? 2 : 1} />
                <circle cx={current.x} cy={current.y} r={isSelected ? 4 : 3} fill={statusColors[p.status]} />
                {isSelected && <circle cx={current.x} cy={current.y} r={16} fill="none" stroke={statusColors[p.status]} strokeWidth="1" strokeOpacity="0.3" strokeDasharray="3,3"><animateTransform attributeName="transform" type="rotate" from={`0 ${current.x} ${current.y}`} to={`360 ${current.x} ${current.y}`} dur="8s" repeatCount="indefinite" /></circle>}
              </g>
              {/* Label */}
              {isSelected && (
                <text x={current.x + 14} y={current.y + 4} fill="currentColor" fontSize="11" fontFamily="monospace" opacity="0.7">
                  {p.loadId}
                </text>
              )}
            </g>
          )
        })}

        {/* Legend */}
        <g transform="translate(20, 440)">
          {Object.entries(statusColors).map(([label, color], i) => (
            <g key={label} transform={`translate(${i * 140}, 0)`}>
              <circle cx="5" cy="5" r="4" fill={color} />
              <text x="14" y="9" fill="currentColor" fontSize="10" opacity="0.5">{label}</text>
            </g>
          ))}
        </g>

        {/* Connect API hint */}
        <text x="500" y="480" textAnchor="middle" fill="currentColor" fontSize="10" opacity="0.25">
          Connect Samsara or Motive API for live GPS positions
        </text>
      </svg>
    </div>
  )
}
