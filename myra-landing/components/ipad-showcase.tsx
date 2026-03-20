"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken =
  "pk.eyJ1IjoicmF5ODgxNiIsImEiOiJjbThlbnUyOWYwM2Z0MmtxMWxpbDl4aTR0In0.by1iUYheNxA294wLpJUyXw";

/* ── Route constants ── */
const ORIGIN: [number, number] = [-87.6298, 41.8781]; // Chicago
const DESTINATION: [number, number] = [-84.388, 33.749]; // Atlanta
const PROGRESS = 0.54;

/* ── Geometry helpers ── */
function arcPoints(
  start: [number, number],
  end: [number, number],
  n: number
): [number, number][] {
  const pts: [number, number][] = [];
  const mx = (start[0] + end[0]) / 2;
  const my = (start[1] + end[1]) / 2;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const h = dist * 0.14;
  const px = (-dy / dist) * h;
  const py = (dx / dist) * h;
  const cx = mx + px,
    cy = my + py;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([
      (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * cx + t * t * end[0],
      (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * cy + t * t * end[1],
    ]);
  }
  return pts;
}

function bearing(a: [number, number], b: [number, number]) {
  const la = (a[1] * Math.PI) / 180,
    lb = (b[1] * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const x = Math.sin(dl) * Math.cos(lb);
  const y =
    Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

/* ── Helper: create truck marker element safely (no innerHTML) ── */
function createTruckMarkerElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText =
    "width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 8px rgba(232,96,31,0.15),0 0 28px rgba(232,96,31,0.5);";
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#e8601f");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path1 = document.createElementNS(svgNS, "path");
  path1.setAttribute("d", "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2");
  const path2 = document.createElementNS(svgNS, "path");
  path2.setAttribute("d", "M15 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.684-.949V8a1 1 0 0 0-1-1h-1");
  const c1 = document.createElementNS(svgNS, "circle");
  c1.setAttribute("cx", "17"); c1.setAttribute("cy", "18"); c1.setAttribute("r", "2");
  const c2 = document.createElementNS(svgNS, "circle");
  c2.setAttribute("cx", "7"); c2.setAttribute("cy", "18"); c2.setAttribute("r", "2");
  svg.appendChild(path1);
  svg.appendChild(path2);
  svg.appendChild(c1);
  svg.appendChild(c2);
  el.appendChild(svg);
  return el;
}

/* ── Reusable SVG fragments ── */
function CheckIcon() {
  return (
    <svg className="check-icon" viewBox="0 0 24 24">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function LocationPinSmall() {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
    </svg>
  );
}

function LivePulse({ style }: { style?: React.CSSProperties }) {
  return (
    <div className="live-pulse" style={style}>
      <div className="live-pulse-ring"></div>
      <div className="live-pulse-dot"></div>
    </div>
  );
}

function StepDotIdle() {
  return <div className="step-dot-idle"></div>;
}

function StepDotActive() {
  return (
    <div className="step-dot-active">
      <div className="step-dot-active-ring"></div>
      <div className="step-dot-active-core"></div>
    </div>
  );
}

/* ═══════════════════════════════════════
   COMPONENT
═══════════════════════════════════════ */
export function IpadShowcase() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const refreshIconRef = useRef<SVGSVGElement>(null);
  const [refreshing, setRefreshing] = useState(false);

  /* ── Scroll-tilt animation ── */
  useEffect(() => {
    const wrap = wrapRef.current;
    const tilt = tiltRef.current;
    const header = headerRef.current;
    if (!wrap || !tilt || !header) return;

    let ticking = false;

    function update() {
      const rect = wrap!.getBoundingClientRect();
      const vh = window.innerHeight;
      const start = vh;
      const end = vh * 0.28;
      const raw = 1 - Math.max(0, Math.min(1, (rect.top - end) / (start - end)));
      const p = raw;

      const rotX = 22 * (1 - p);
      const sc = 1.06 - 0.06 * p;
      const ty = -60 * p;

      tilt!.style.transform = `rotateX(${rotX.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      header!.style.transform = `translateY(${ty.toFixed(1)}px)`;
      ticking = false;
    }

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    update();

    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* ── Mapbox init ── */
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const fullRoute = arcPoints(ORIGIN, DESTINATION, 120);
    const cutIdx = Math.floor(PROGRESS * fullRoute.length);
    const traveled = fullRoute.slice(0, cutIdx + 1);
    const truckPt = fullRoute[cutIdx];
    const truckBear = bearing(
      fullRoute[Math.max(0, cutIdx - 1)],
      fullRoute[Math.min(fullRoute.length - 1, cutIdx + 1)]
    );

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-85.8, 37.8],
      zoom: 5.2,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      interactive: true,
    });

    mapRef.current = map;

    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      "bottom-right"
    );

    map.on("load", () => {
      // Full route dashed
      map.addSource("full-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: fullRoute },
        },
      });
      map.addLayer({
        id: "full-route-line",
        type: "line",
        source: "full-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "rgba(255,255,255,0.13)",
          "line-width": 2,
          "line-dasharray": [2, 5],
        },
      });

      // Traveled glow
      map.addSource("traveled", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: traveled },
        },
      });
      map.addLayer({
        id: "traveled-glow",
        type: "line",
        source: "traveled",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#e8601f",
          "line-width": 14,
          "line-blur": 10,
          "line-opacity": 0.35,
        },
      });
      map.addLayer({
        id: "traveled-line",
        type: "line",
        source: "traveled",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#e8601f", "line-width": 3 },
      });

      // Origin marker
      const originEl = document.createElement("div");
      originEl.style.cssText =
        "width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 0 0 5px rgba(255,255,255,0.15),0 0 18px rgba(255,255,255,0.4);";
      new mapboxgl.Marker({ element: originEl, anchor: "center" })
        .setLngLat(ORIGIN)
        .addTo(map);

      // Destination marker - pulsing orange
      const destEl = document.createElement("div");
      destEl.style.cssText =
        "width:16px;height:16px;border-radius:50%;background:#e8601f;box-shadow:0 0 0 6px rgba(232,96,31,0.2),0 0 20px rgba(232,96,31,0.6);animation:mapPulse 2s ease-out infinite;";
      new mapboxgl.Marker({ element: destEl, anchor: "center" })
        .setLngLat(DESTINATION)
        .addTo(map);

      // Truck marker (built with safe DOM methods)
      const truckEl = createTruckMarkerElement();
      new mapboxgl.Marker({
        element: truckEl,
        anchor: "center",
        rotation: truckBear - 90,
      })
        .setLngLat(truckPt)
        .addTo(map);

      // Fit bounds
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend(ORIGIN);
      bounds.extend(DESTINATION);
      map.fitBounds(bounds, {
        padding: { top: 55, bottom: 55, left: 45, right: 45 },
        duration: 1200,
      });
    });

    // Add pulse keyframe for destination dot
    const style = document.createElement("style");
    style.textContent =
      "@keyframes mapPulse{0%{box-shadow:0 0 0 0 rgba(232,96,31,0.4),0 0 0 6px rgba(232,96,31,0.2)}70%{box-shadow:0 0 0 12px rgba(232,96,31,0),0 0 0 6px rgba(232,96,31,0)}100%{box-shadow:0 0 0 0 rgba(232,96,31,0),0 0 0 6px rgba(232,96,31,0.2)}}";
    document.head.appendChild(style);

    // Attribution font size
    const attrTimer = setTimeout(() => {
      const attr = mapContainerRef.current?.querySelector(
        ".mapboxgl-ctrl-attrib"
      );
      if (attr) (attr as HTMLElement).style.fontSize = "8px";
    }, 2000);

    return () => {
      clearTimeout(attrTimer);
      map.remove();
      style.remove();
    };
  }, []);

  /* ── Refresh button handler ── */
  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    if (refreshIconRef.current) {
      refreshIconRef.current.style.animation = "spin .9s linear";
    }
    setTimeout(() => {
      if (refreshIconRef.current) {
        refreshIconRef.current.style.animation = "";
      }
      setRefreshing(false);
    }, 1200);
  }, [refreshing]);

  return (
    <section className="showcase-section">
      <div className="showcase-header" ref={headerRef}>
        <div className="showcase-eyebrow">Live Platform Demo</div>
        <h2 className="showcase-h2">
          Real-Time Visibility.
          <br />
          Always.
        </h2>
        <p className="showcase-sub">
          Track every load from pickup to delivery — live, accurate, zero calls
          required.
        </p>
      </div>

      <div className="scroll-anim-wrap" ref={wrapRef}>
        <div className="ipad-wrap ipad-tilt" ref={tiltRef}>
          <div className="ipad-glow"></div>
          <div className="ipad-outer">
            <div className="ipad-camera"></div>
            <div className="ipad-inner">
              <div className="ipad-screen">
                <div className="ipad-glare"></div>

                {/* ── TRACKER APP ── */}
                <div className="tracker">
                  {/* Header */}
                  <header className="t-header">
                    <div className="t-header-brand">
                      <div className="t-header-logo">M</div>
                      <div className="t-header-name">
                        Myra<span>AI</span>
                      </div>
                      <div className="t-header-divider"></div>
                      <span className="t-header-sub">Shipment Tracking</span>
                    </div>
                    <div className="t-header-meta">
                      <div className="t-live-dot">
                        <LivePulse />
                        <span
                          style={{
                            fontSize: "10px",
                            color: "var(--text-muted)",
                          }}
                        >
                          Updated{" "}
                          <strong style={{ color: "var(--text)" }}>
                            2 min ago
                          </strong>
                        </span>
                      </div>
                    </div>
                  </header>

                  {/* Status Banner */}
                  <section className="t-status-banner">
                    <div className="t-status-top">
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div className="status-badge">
                          <svg
                            className="icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
                            <path d="M15 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.684-.948l-1.923-.641a1 1 0 0 1-.684-.949V8a1 1 0 0 0-1-1h-1" />
                            <circle cx="17" cy="18" r="2" />
                            <circle cx="7" cy="18" r="2" />
                          </svg>
                          In Transit
                        </div>
                        <div className="status-location">
                          <svg
                            className="icon"
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                          Nashville, TN
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div className="t-eta-pill">
                          <svg
                            className="icon"
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--primary)"
                            strokeWidth="2.5"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                          <span className="t-eta-label">ETA</span>
                          <span className="t-eta-val">
                            Fri, Feb 28 &middot; 2:30 PM EST
                          </span>
                        </div>
                        <span className="t-miles">312 mi remaining</span>
                      </div>
                    </div>

                    {/* Stepper */}
                    <div className="stepper">
                      {/* Booked */}
                      <div className="step">
                        <div className="step-node-wrap">
                          <div className="step-node done">
                            <CheckIcon />
                          </div>
                          <span className="step-label done">Booked</span>
                        </div>
                        <div className="step-connector">
                          <div className="step-connector-fill filled"></div>
                        </div>
                      </div>
                      {/* Picked Up */}
                      <div className="step">
                        <div className="step-node-wrap">
                          <div className="step-node done">
                            <CheckIcon />
                          </div>
                          <span className="step-label done">Picked Up</span>
                        </div>
                        <div className="step-connector">
                          <div className="step-connector-fill filled"></div>
                        </div>
                      </div>
                      {/* In Transit (active) */}
                      <div className="step">
                        <div className="step-node-wrap">
                          <div className="step-node active">
                            <StepDotActive />
                          </div>
                          <span className="step-label active">In Transit</span>
                        </div>
                        <div className="step-connector">
                          <div className="step-connector-fill"></div>
                        </div>
                      </div>
                      {/* Break-point */}
                      <div className="step">
                        <div className="step-node-wrap">
                          <div className="step-node">
                            <StepDotIdle />
                          </div>
                          <span className="step-label">Break-point</span>
                        </div>
                        <div className="step-connector">
                          <div className="step-connector-fill"></div>
                        </div>
                      </div>
                      {/* Docking */}
                      <div className="step">
                        <div className="step-node-wrap">
                          <div className="step-node">
                            <StepDotIdle />
                          </div>
                          <span className="step-label">Docking</span>
                        </div>
                        <div className="step-connector">
                          <div className="step-connector-fill"></div>
                        </div>
                      </div>
                      {/* Delivered */}
                      <div className="step" style={{ flex: 0 }}>
                        <div className="step-node-wrap">
                          <div className="step-node">
                            <StepDotIdle />
                          </div>
                          <span className="step-label">Delivered</span>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Main content */}
                  <main style={{ padding: "14px", flex: 1 }}>
                    {/* Subheader row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: "14px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "9px",
                            color: "var(--text-muted)",
                          }}
                        >
                          Tracking
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: "9px",
                            fontWeight: 600,
                            color: "var(--text)",
                          }}
                        >
                          MYR-2024-08471
                        </span>
                      </div>
                      <button
                        onClick={handleRefresh}
                        disabled={refreshing}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "5px",
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          padding: "5px 10px",
                          fontSize: "9px",
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          fontFamily: "'Barlow',sans-serif",
                          transition: "all .2s",
                        }}
                      >
                        <svg
                          ref={refreshIconRef}
                          width="9"
                          height="9"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        >
                          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                          <path d="M21 3v5h-5" />
                          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                          <path d="M8 16H3v5" />
                        </svg>
                        Refresh
                      </button>
                    </div>

                    {/* MAPBOX MAP */}
                    <div className="t-map-wrap" style={{ marginBottom: "14px" }}>
                      <div style={{ position: "relative" }}>
                        {/* City label overlay */}
                        <div className="t-map-origin-label">
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <div
                              className="map-city-dot"
                              style={{
                                background: "#fff",
                                boxShadow: "0 0 6px rgba(255,255,255,.5)",
                              }}
                            ></div>
                            <span className="map-city-name">Chicago, IL</span>
                          </div>
                          <span className="map-city-sep">to</span>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <div
                              className="map-city-dot"
                              style={{
                                background: "var(--primary)",
                                boxShadow: "0 0 6px rgba(232,96,31,.6)",
                              }}
                            ></div>
                            <span className="map-city-name">Atlanta, GA</span>
                          </div>
                        </div>

                        {/* Mapbox map container */}
                        <div
                          ref={mapContainerRef}
                          style={{
                            width: "100%",
                            height: "260px",
                            borderRadius: 0,
                          }}
                        />

                        {/* Location pill */}
                        <div className="t-map-location-pill">
                          <LivePulse
                            style={{ width: "7px", height: "7px" }}
                          />
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--primary)"
                            strokeWidth="2.5"
                          >
                            <polygon points="3 11 22 2 13 21 11 13 3 11" />
                          </svg>
                          <span className="t-map-location-name">
                            Nashville, TN
                          </span>
                          <span className="t-map-live-tag">&middot; Live</span>
                        </div>
                      </div>
                      <div className="map-resize-handle">
                        <svg
                          width="14"
                          height="10"
                          viewBox="0 0 14 10"
                          fill="none"
                        >
                          <rect
                            x="0"
                            y="1"
                            width="14"
                            height="1.2"
                            rx=".6"
                            fill="rgba(255,255,255,.2)"
                          />
                          <rect
                            x="0"
                            y="4.4"
                            width="14"
                            height="1.2"
                            rx=".6"
                            fill="rgba(255,255,255,.13)"
                          />
                          <rect
                            x="0"
                            y="7.8"
                            width="14"
                            height="1.2"
                            rx=".6"
                            fill="rgba(255,255,255,.08)"
                          />
                        </svg>
                      </div>
                    </div>

                    {/* Shipment details */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr",
                        gap: "14px",
                        marginBottom: "14px",
                      }}
                    >
                      {/* Route card */}
                      <div className="t-section-card">
                        <div className="t-card-header">
                          <div className="t-card-title">Route</div>
                        </div>
                        <div className="t-card-body">
                          <div className="route-grid">
                            <div className="route-box">
                              <div
                                className="route-city-label"
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                }}
                              >
                                <div
                                  className="route-dot"
                                  style={{
                                    background: "#fff",
                                    boxShadow:
                                      "0 0 5px rgba(255,255,255,.4)",
                                  }}
                                ></div>
                                Origin
                              </div>
                              <div className="route-city">Chicago, IL</div>
                              <div className="route-addr">
                                1420 W Fulton St, Chicago, IL 60607
                              </div>
                              <div className="route-date">
                                <CalendarIcon />
                                Thu, Feb 27{" "}
                                <strong>7:00 AM CST</strong>
                              </div>
                            </div>
                            <div className="route-arrow">
                              <div className="route-arrow-circle">
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="var(--primary)"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                >
                                  <path d="M5 12h14" />
                                  <path d="m12 5 7 7-7 7" />
                                </svg>
                              </div>
                            </div>
                            <div className="route-box dest">
                              <div
                                className="route-city-label"
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                }}
                              >
                                <div
                                  className="route-dot"
                                  style={{
                                    background: "var(--primary)",
                                    boxShadow:
                                      "0 0 5px rgba(232,96,31,.5)",
                                  }}
                                ></div>
                                Destination
                              </div>
                              <div className="route-city">Atlanta, GA</div>
                              <div className="route-addr">
                                2550 Cumberland Pkwy SE, Atlanta, GA 30339
                              </div>
                              <div className="route-date">
                                <CalendarIcon />
                                Fri, Feb 28{" "}
                                <strong>2:30 PM EST</strong>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Load info card */}
                      <div className="t-section-card">
                        <div className="t-card-header">
                          <div className="t-card-title">Load Info</div>
                        </div>
                        <div
                          className="t-card-body"
                          style={{ paddingTop: "4px", paddingBottom: "4px" }}
                        >
                          <div className="info-row">
                            <span className="info-label">Load #</span>
                            <span className="info-val mono">
                              MYR-2024-08471
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">PO / Ref</span>
                            <span className="info-val mono">
                              PO-88321 / REF-55102
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Commodity</span>
                            <span className="info-val">
                              Consumer Electronics
                            </span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Weight</span>
                            <span className="info-val">38,200 lbs</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Pieces</span>
                            <span className="info-val">22 pallets</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Activity Timeline */}
                    <div
                      className="t-section-card"
                      style={{ marginBottom: "14px" }}
                    >
                      <div className="t-card-header">
                        <div className="t-card-title">Activity Log</div>
                      </div>
                      <div className="t-card-body">
                        <ol className="timeline-list">
                          {/* Booked */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector done"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node done">
                              <CheckIcon />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status done">
                                  Load Booked
                                </span>
                                <span className="timeline-time">
                                  Wed, Feb 26 &middot; 4:15 PM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Chicago, IL
                              </div>
                              <div className="timeline-note">
                                Load confirmed and carrier assigned.
                              </div>
                            </div>
                          </li>

                          {/* Picked Up */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector done"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node done">
                              <CheckIcon />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status done">
                                  Picked Up
                                </span>
                                <span className="timeline-time">
                                  Thu, Feb 27 &middot; 7:22 AM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Chicago, IL &middot; 1420 W Fulton St
                              </div>
                              <div className="timeline-note">
                                Driver checked in. Trailer sealed. BOL #44821.
                              </div>
                            </div>
                          </li>

                          {/* En Route Checkpoint */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector done"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node done">
                              <CheckIcon />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status done">
                                  En Route Checkpoint
                                </span>
                                <span className="timeline-time">
                                  Thu, Feb 27 &middot; 11:48 AM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Indianapolis, IN &middot; I-65 S
                              </div>
                              <div className="timeline-note">
                                Routine GPS ping. All clear.
                              </div>
                            </div>
                          </li>

                          {/* In Transit (active) */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node active">
                              <StepDotActive />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status active">
                                  In Transit
                                </span>
                                <span className="timeline-time">
                                  Thu, Feb 27 &middot; 3:10 PM
                                </span>
                              </div>
                              <div
                                className="timeline-loc"
                                style={{ color: "var(--primary)" }}
                              >
                                <LocationPinSmall />
                                Nashville, TN
                              </div>
                              <div className="timeline-note active">
                                Driver on I-24 E. On schedule.
                              </div>
                            </div>
                          </li>

                          {/* Break-point (pending) */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node">
                              <StepDotIdle />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status">
                                  Break-point / Transit Stop
                                </span>
                                <span className="timeline-time">
                                  Fri, Feb 28 &middot; 12:45 PM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Memphis, TN &middot; Love&apos;s Travel Stop
                              </div>
                              <div className="timeline-note">
                                Driver rest break. Trailer secured.
                              </div>
                            </div>
                          </li>

                          {/* Docking */}
                          <li className="timeline-item">
                            <div
                              className="timeline-connector"
                              style={{ height: "calc(100% - 8px)" }}
                            ></div>
                            <div className="timeline-node">
                              <StepDotIdle />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status">
                                  Docking
                                </span>
                                <span className="timeline-time">
                                  Est. Fri, Feb 28 &middot; 2:00 PM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Atlanta, GA &middot; 2550 Cumberland Pkwy SE
                              </div>
                              <div className="timeline-note">
                                Awaiting dock assignment and bay availability.
                              </div>
                            </div>
                          </li>

                          {/* Delivered */}
                          <li className="timeline-item">
                            <div className="timeline-node">
                              <StepDotIdle />
                            </div>
                            <div className="timeline-content">
                              <div className="timeline-row">
                                <span className="timeline-status">
                                  Delivered
                                </span>
                                <span className="timeline-time">
                                  Est. Fri, Feb 28 &middot; 2:30 PM
                                </span>
                              </div>
                              <div className="timeline-loc">
                                <LocationPinSmall />
                                Atlanta, GA &middot; 2550 Cumberland Pkwy SE
                              </div>
                            </div>
                          </li>
                        </ol>
                      </div>
                    </div>

                    {/* POD */}
                    <div
                      className="t-section-card"
                      style={{ marginBottom: "14px" }}
                    >
                      <div className="t-card-header">
                        <div className="t-card-title">Proof of Delivery</div>
                      </div>
                      <div className="t-card-body">
                        <div className="pod-empty">
                          <div className="pod-icon-wrap">
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="var(--text-muted)"
                              strokeWidth="2"
                              strokeLinecap="round"
                            >
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 6v6l4 2" />
                            </svg>
                          </div>
                          <div className="pod-title">Awaiting Delivery</div>
                          <div className="pod-sub">
                            The POD document will appear here automatically once
                            the driver confirms delivery.
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Carrier */}
                    <div
                      className="t-section-card"
                      style={{ marginBottom: "14px" }}
                    >
                      <div className="t-card-header">
                        <div className="t-card-title">Carrier</div>
                      </div>
                      <div className="t-card-body">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "12px",
                            marginBottom: "14px",
                          }}
                        >
                          <div className="carrier-avatar">A</div>
                          <div>
                            <div className="carrier-name">
                              Apex Freight LLC
                            </div>
                            <div className="carrier-mc">
                              MC # 884721 &middot; DOT # 3219044
                            </div>
                          </div>
                        </div>
                        <div style={{ paddingTop: 0 }}>
                          <div className="info-row">
                            <span className="info-label">Driver</span>
                            <span className="info-val">James R.</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Truck</span>
                            <span className="info-val">Kenworth T680</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Plate</span>
                            <span className="info-val mono">IL-482T</span>
                          </div>
                          <div className="info-row">
                            <span className="info-label">Trailer</span>
                            <span className="info-val">
                              53&apos; Dry Van &middot; TRL-9921
                            </span>
                          </div>
                        </div>
                        <div className="carrier-verified">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--primary)"
                            strokeWidth="2.5"
                          >
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                          </svg>
                          <span className="carrier-verified-text">
                            Carrier verified and insured
                          </span>
                        </div>
                      </div>
                    </div>
                  </main>

                  {/* Tracker footer */}
                  <footer className="t-footer">
                    <div className="t-footer-brand">
                      <div
                        className="t-header-logo"
                        style={{
                          width: "22px",
                          height: "22px",
                          fontSize: "9px",
                        }}
                      >
                        M
                      </div>
                      <div
                        className="t-header-name"
                        style={{ fontSize: "12px" }}
                      >
                        Myra<span>AI</span>
                      </div>
                      <div className="t-header-divider"></div>
                      <span
                        style={{
                          fontSize: "9px",
                          color: "var(--text-muted)",
                        }}
                      >
                        Freight Brokerage
                      </span>
                    </div>
                    <div className="t-footer-contact">
                      <a href="tel:+18005550100" className="t-footer-link">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        >
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.59 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                        </svg>
                        1-800-MYRA-AI
                      </a>
                      <a
                        href="mailto:dispatch@myra-ai.com"
                        className="t-footer-link"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        >
                          <rect
                            width="20"
                            height="16"
                            x="2"
                            y="4"
                            rx="2"
                          />
                          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                        </svg>
                        dispatch@myra-ai.com
                      </a>
                    </div>
                    <div className="t-footer-legal">
                      This tracking page was sent by Myra AI on behalf of your
                      freight broker. Location data refreshes every 15 minutes.
                      <br />
                      &copy; 2025 Myra AI, Inc.
                    </div>
                  </footer>
                </div>
                {/* /tracker */}
              </div>
              {/* /ipad-screen */}
            </div>
            {/* /ipad-inner */}
          </div>
          {/* /ipad-outer */}
          <div className="ipad-reflection"></div>
        </div>
        {/* /ipad-wrap */}
      </div>
      {/* /scroll-anim-wrap */}
    </section>
  );
}
