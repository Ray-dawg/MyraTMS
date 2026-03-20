'use client'

import { useEffect, useRef } from 'react'

function createTruckSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', '#e8601f')
  svg.setAttribute('stroke-width', '2.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path1.setAttribute('d', 'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2')
  const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path2.setAttribute('d', 'M15 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.684-.949V8a1 1 0 0 0-1-1h-1')
  const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  c1.setAttribute('cx', '17'); c1.setAttribute('cy', '18'); c1.setAttribute('r', '2')
  const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  c2.setAttribute('cx', '7'); c2.setAttribute('cy', '18'); c2.setAttribute('r', '2')
  svg.appendChild(path1); svg.appendChild(path2); svg.appendChild(c1); svg.appendChild(c2)
  return svg
}

function arcPoints(start: number[], end: number[], n: number) {
  const pts: number[][] = []
  const mx = (start[0] + end[0]) / 2
  const my = (start[1] + end[1]) / 2
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const dist = Math.sqrt(dx * dx + dy * dy)
  const h = dist * 0.12
  const px = (-dy / dist) * h
  const py = (dx / dist) * h
  const cx = mx + px
  const cy = my + py
  for (let i = 0; i <= n; i++) {
    const t = i / n
    pts.push([
      (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * cx + t * t * end[0],
      (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * cy + t * t * end[1],
    ])
  }
  return pts
}

export function FeaturesSection() {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const initMap = async () => {
      const mapboxgl = (await import('mapbox-gl')).default
      await import('mapbox-gl/dist/mapbox-gl.css')

      mapboxgl.accessToken = 'pk.eyJ1IjoicmF5ODgxNiIsImEiOiJjbThlbnUyOWYwM2Z0MmtxMWxpbDl4aTR0In0.by1iUYheNxA294wLpJUyXw'

      const map = new mapboxgl.Map({
        container: mapRef.current!,
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [-89.0, 37.5],
        zoom: 4.3,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
        interactive: false,
      })

      mapInstanceRef.current = map

      const routes = [
        { from: [-87.63, 41.88], to: [-84.39, 33.75], color: '#e8601f' },
        { from: [-95.37, 29.76], to: [-90.07, 29.95], color: '#e8601f' },
        { from: [-118.24, 34.05], to: [-115.14, 36.17], color: 'rgba(232,96,31,.5)' },
        { from: [-73.94, 40.67], to: [-75.17, 39.95], color: 'rgba(232,96,31,.5)' },
        { from: [-93.27, 44.98], to: [-87.63, 41.88], color: 'rgba(232,96,31,.35)' },
      ]

      map.on('load', () => {
        routes.forEach((route, i) => {
          const arc = arcPoints(route.from, route.to, 80)

          map.addSource(`route-glow-${i}`, {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: arc } },
          })
          map.addLayer({
            id: `route-glow-${i}`, type: 'line', source: `route-glow-${i}`,
            paint: { 'line-color': route.color, 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.3 },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
          })

          map.addSource(`route-${i}`, {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: arc } },
          })
          map.addLayer({
            id: `route-${i}`, type: 'line', source: `route-${i}`,
            paint: { 'line-color': route.color, 'line-width': 2 },
            layout: { 'line-join': 'round', 'line-cap': 'round' },
          })

          const originEl = document.createElement('div')
          originEl.style.cssText = `width:10px;height:10px;border-radius:50%;background:${i < 2 ? '#fff' : 'rgba(255,255,255,.4)'};box-shadow:0 0 8px rgba(255,255,255,.3);`
          new mapboxgl.Marker({ element: originEl, anchor: 'center' }).setLngLat(route.from as [number, number]).addTo(map)

          const destEl = document.createElement('div')
          destEl.style.cssText = `width:${i < 2 ? 12 : 8}px;height:${i < 2 ? 12 : 8}px;border-radius:50%;background:#e8601f;box-shadow:0 0 ${i < 2 ? 12 : 6}px rgba(232,96,31,.6);`
          new mapboxgl.Marker({ element: destEl, anchor: 'center' }).setLngLat(route.to as [number, number]).addTo(map)

          if (i === 0) {
            const progress = 0.6
            const truckPt = arc[Math.floor(progress * arc.length)]
            const truckEl = document.createElement('div')
            truckEl.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 6px rgba(232,96,31,.15),0 0 20px rgba(232,96,31,.4);'
            truckEl.appendChild(createTruckSvg())
            new mapboxgl.Marker({ element: truckEl, anchor: 'center' }).setLngLat(truckPt as [number, number]).addTo(map)
          }
        })

        const networkCities = [
          [-83.05, 42.33], [-81.69, 41.50], [-86.16, 39.77],
          [-97.33, 32.75], [-104.99, 39.74], [-122.42, 37.77], [-80.19, 25.76],
        ]
        networkCities.forEach(city => {
          const el = document.createElement('div')
          el.style.cssText = 'width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.2);'
          new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(city as [number, number]).addTo(map)
        })
      })
    }

    initMap()

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove()
        mapInstanceRef.current = null
      }
    }
  }, [])

  return (
    <section className="features-section">
      <div className="features-inner">
        <div className="features-top-grid">
          <h2 className="features-h2">
            Built for the<br />way freight<br />actually moves.
          </h2>
          <p className="features-desc">
            From first call to final signature, Myra removes every friction
            point your team deals with daily.
          </p>
        </div>

        <div className="features-visual">
          <div className="features-visual-inner" style={{ position: 'relative' }}>
            <div ref={mapRef} style={{ width: '100%', height: '220px' }} />
            <div style={{
              position: 'absolute', top: 12, left: 12, zIndex: 5,
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(232,96,31,.12)', border: '1px solid rgba(232,96,31,.25)',
              borderRadius: 9, padding: '4px 12px',
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: '#e8601f',
                animation: 'livePulse 1.6s ease-out infinite',
              }} />
              <span style={{
                fontFamily: 'Barlow, sans-serif', fontSize: 8, fontWeight: 600,
                letterSpacing: '.08em', color: 'rgba(232,96,31,.85)',
              }}>LIVE</span>
            </div>
            <div style={{
              position: 'absolute', top: 12, right: 12, zIndex: 5,
              fontFamily: 'Barlow, sans-serif', fontSize: 8, letterSpacing: '.1em',
              color: 'rgba(255,255,255,.12)',
            }}>
              MYRA LOGISTICS NETWORK
            </div>
            <div className="features-visual-fade"></div>
          </div>
        </div>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon-wrap">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <div className="feature-title">AI Dispatch Engine</div>
            <div className="feature-desc">
              Matches loads to verified carriers in seconds. Lane history,
              availability, safety score — weighed automatically.
              No broker intuition required.
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon-wrap">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11" />
              </svg>
            </div>
            <div className="feature-title">Real-Time Visibility</div>
            <div className="feature-desc">
              GPS updates every 15 minutes. Instant exception alerts.
              Full load history from first ping to signed POD, always on.
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon-wrap">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
            </div>
            <div className="feature-title">Smart Rate Intelligence</div>
            <div className="feature-desc">
              Market-aware pricing on every load. You never overpay.
              Every rate is justified by live lane data — not a broker&apos;s margin.
            </div>
          </div>

          <div className="feature-card">
            <div className="feature-icon-wrap">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e8601f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="feature-title">Verified Carrier Network</div>
            <div className="feature-desc">
              Every carrier is FMCSA-checked, safety-rated above 85,
              and carrying $2M+ cargo insurance before they touch your freight.
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
