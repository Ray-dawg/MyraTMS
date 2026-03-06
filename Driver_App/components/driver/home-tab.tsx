'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Package, MapPin, Navigation, Truck, Clock, Star,
  ChevronRight, ChevronLeft, Phone, MessageSquare,
  CheckCircle, XCircle, Loader2, PlayCircle, PauseCircle,
  DollarSign, FileText, Upload, RotateCcw, Wifi, WifiOff,
} from 'lucide-react'
import { toast } from 'sonner'
import { T, fmt } from '@/lib/driver-theme'
import { driverFetch, getDriverInfo } from '@/lib/api'
import { GlassPanel, Pill } from '@/components/driver/shared'
import { DriverMap } from '@/components/driver/driver-map-dynamic'

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

// ── Turn-by-turn mock (future: real routing API) ──
const TURNS = [
  { icon: "straight", instruction: "Continue on Highway 401 East", distance: "12.4 km", duration: "8 min" },
  { icon: "right", instruction: "Take exit 394 toward Brock Rd", distance: "800 m", duration: "1 min" },
  { icon: "right", instruction: "Turn right onto Brock Rd N", distance: "2.1 km", duration: "3 min" },
  { icon: "left", instruction: "Turn left onto Bayly St", distance: "1.8 km", duration: "2 min" },
  { icon: "straight", instruction: "Arrive at destination on right", distance: "200 m", duration: "1 min" },
]

interface DriverLoad {
  id: string
  origin: string
  destination: string
  status: string
  pickup_date: string | null
  delivery_date: string | null
  equipment: string
  weight: string
  shipper_name: string
  carrier_name: string
  commodity?: string
  origin_lat?: number | null
  origin_lng?: number | null
  dest_lat?: number | null
  dest_lng?: number | null
  // UI-only fields
  timer?: number
  freightRate?: number
}

// ── Status mapping: UI phase → DB status ──
const PHASE_TO_STATUS: Record<string, string> = {
  navigating_to_pickup: "accepted",
  at_pickup: "at_pickup",
  navigating_to_dropoff: "in_transit",
  at_dropoff: "at_delivery",
  complete: "delivered",
}

// ── Helper: TurnIcon ──
function TurnIcon({ type, size = 16 }: { type: string; size?: number }) {
  if (type === "right") return <ChevronRight size={size} color={T.accent} />
  if (type === "left") return <ChevronLeft size={size} color={T.accent} />
  return <Navigation size={size} color={T.accent} />
}

// ── Map Background ──
function MapBG({ phase, load }: { phase: string; load: DriverLoad | null }) {
  const rc = phase.includes("pickup") ? T.blue : T.accent
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "linear-gradient(155deg, #060e1a, #091828, #0a1c2e)" }}>
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.07 }}>
        <defs>
          <pattern id="g2" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke={T.accent} strokeWidth=".5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#g2)" />
      </svg>
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.18 }}>
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#fff" strokeWidth="9" />
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#091a2e" strokeWidth="7" />
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#fff" strokeWidth="1.5" strokeDasharray="22,16" />
        <line x1="28%" y1="0" x2="42%" y2="100%" stroke="#fff" strokeWidth="6" />
        <line x1="28%" y1="0" x2="42%" y2="100%" stroke="#091a2e" strokeWidth="4" />
      </svg>
      {(phase === "navigating_to_pickup" || phase === "navigating_to_dropoff") && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <path d="M 52 75% Q 28% 52% 76% 28%" stroke={rc} strokeWidth="3.5" fill="none" strokeDasharray="9,6" opacity=".65">
            <animate attributeName="stroke-dashoffset" from="0" to="-60" dur="1.5s" repeatCount="indefinite" />
          </path>
        </svg>
      )}
      {load && (phase === "navigating_to_pickup" || phase === "selecting") && (
        <div style={{ position: "absolute", left: "26%", top: "34%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg, #60a5fa, #3b82f6)", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 16px rgba(96,165,250,.5)" }}>
            <Package size={13} color="#fff" />
          </div>
          <div style={{ width: 1, height: 12, background: "#60a5fa" }} />
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#60a5fa" }} />
        </div>
      )}
      {load && (phase === "navigating_to_dropoff" || phase === "at_dropoff") && (
        <div style={{ position: "absolute", left: "71%", top: "23%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(135deg, #34d399, #059669)", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 16px rgba(52,211,153,.5)" }}>
            <MapPin size={13} color="#fff" />
          </div>
          <div style={{ width: 1, height: 12, background: "#34d399" }} />
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} />
        </div>
      )}
      {/* Driver truck marker */}
      <div style={{
        position: "absolute",
        left: phase === "navigating_to_dropoff" ? "44%" : "50%",
        top: phase === "navigating_to_dropoff" ? "50%" : "57%",
        transform: "translate(-50%,-50%)",
        transition: "all 2.5s ease",
      }}>
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, width: 44, height: 44, borderRadius: "50%", background: T.accent, animation: "driverPing 2s ease-in-out infinite", opacity: 0.15 }} />
          <div style={{
            position: "relative", width: 44, height: 44, borderRadius: "50%",
            background: T.accentGradient, border: "2.5px solid #fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 4px 20px ${T.accentGlow}`,
          }}>
            <img src="/icons/icon-192.png" alt="" width={24} height={24} style={{ borderRadius: 6 }} />
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 10, right: 14, display: "flex", alignItems: "center", gap: 4, color: "rgba(255,255,255,.18)", fontSize: 9, fontFamily: "monospace", letterSpacing: ".15em" }}>
        <img src="/icons/icon-192.png" alt="" width={12} height={12} style={{ borderRadius: 3, opacity: 0.4 }} />
        MYRA NAV
      </div>
    </div>
  )
}

// ── Load Card ──
function LoadCard({ load, onConfirm, onDeny, loading }: { load: DriverLoad; onConfirm: (l: DriverLoad) => void; onDeny: (id: string) => void; loading?: boolean }) {
  const maxTimer = load.timer || 120
  const [timer, setTimer] = useState(maxTimer)
  const [vis, setVis] = useState(true)

  useEffect(() => {
    if (timer <= 0) return
    const id = setTimeout(() => setTimer(p => p - 1), 1000)
    return () => clearTimeout(id)
  }, [timer])

  const pct = (timer / maxTimer) * 100
  const tc = pct > 55 ? T.accent : pct > 25 ? T.amber : T.red
  const dismiss = (fn: () => void) => { setVis(false); setTimeout(fn, 300) }

  return (
    <div style={{ transition: "opacity .3s, transform .3s", opacity: vis ? 1 : 0, transform: vis ? "scale(1)" : "scale(.94)" }}>
      <GlassPanel style={{ border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ height: 3, background: "rgba(255,255,255,.06)" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: tc, transition: "width 1s linear, background .5s" }} />
        </div>
        <div style={{ padding: "14px 16px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div>
              <div style={{ color: T.textMuted, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 2 }}>Load ID</div>
              <div style={{ color: T.textPrimary, fontWeight: 700, fontSize: 13 }}>{load.id}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Pill color={T.blue}>{load.equipment || "Dry Van"}</Pill>
              <div style={{ background: `${tc}1a`, border: `1px solid ${tc}44`, borderRadius: 8, padding: "3px 8px", color: tc, fontSize: 12, fontWeight: 800, fontFamily: "monospace", minWidth: 40, textAlign: "center" }}>{timer}s</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4, gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.blue, boxShadow: `0 0 8px ${T.blue}` }} />
              <div style={{ width: 1.5, height: 28, background: `linear-gradient(to bottom, ${T.blue}, ${T.accent})`, opacity: 0.5 }} />
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, boxShadow: `0 0 8px ${T.accent}` }} />
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ color: T.textMuted, fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em" }}>Pick-up{load.pickup_date ? ` · ${fmt(load.pickup_date)}` : ""}</div>
                <div style={{ color: T.textPrimary, fontSize: 12, fontWeight: 600, marginTop: 1 }}>{load.origin}</div>
              </div>
              <div style={{ marginTop: 8 }}>
                <div style={{ color: T.textMuted, fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em" }}>Drop-off</div>
                <div style={{ color: T.textPrimary, fontSize: 12, fontWeight: 600, marginTop: 1 }}>{load.destination}</div>
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
            {[
              { l: "Equipment", v: load.equipment || "Dry Van" },
              { l: "Weight", v: load.weight || "N/A" },
              { l: "Shipper", v: load.shipper_name || "—" },
            ].map(({ l, v }) => (
              <div key={l} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "8px 6px", textAlign: "center" }}>
                <div style={{ color: T.textMuted, fontSize: 8, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 3 }}>{l}</div>
                <div style={{ color: T.textPrimary, fontSize: 11, fontWeight: 700 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => dismiss(() => onDeny(load.id))} style={{ flex: 1, padding: "11px 0", borderRadius: 13, background: T.redDim, border: `1px solid ${T.red}33`, color: T.red, fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer" }}>
              <XCircle size={14} />Decline
            </button>
            <button onClick={() => dismiss(() => onConfirm(load))} disabled={loading} style={{ flex: 2, padding: "11px 0", borderRadius: 13, background: T.accentGradient, border: "none", color: T.bg, fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: loading ? "wait" : "pointer", boxShadow: `0 4px 18px ${T.accentGlow}`, opacity: loading ? 0.8 : 1 }}>
              {loading ? <><Loader2 size={14} style={{ animation: "driverSpin 1s linear infinite" }} />Accepting...</> : <><CheckCircle size={14} />Accept Load</>}
            </button>
          </div>
        </div>
      </GlassPanel>
    </div>
  )
}

// ── Turn-by-Turn Panel ──
function TurnPanel({ step, onNext, onPrev }: { step: number; onNext: () => void; onPrev: () => void }) {
  const cur = TURNS[step] || TURNS[0]
  return (
    <div style={{ background: `${T.accent}08`, border: `1px solid ${T.accent}20`, borderRadius: 16, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <TurnIcon type={cur.icon} size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: T.textPrimary, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur.instruction}</div>
          <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>{cur.distance} · {cur.duration}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {step > 0 && <button onClick={onPrev} style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(255,255,255,.06)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronLeft size={14} color={T.textMuted} /></button>}
          {step < TURNS.length - 1 && <button onClick={onNext} style={{ width: 28, height: 28, borderRadius: 8, background: T.accentDim, border: `1px solid ${T.accent}33`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><ChevronRight size={14} color={T.accent} /></button>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
        {TURNS.map((_, i) => <div key={i} style={{ flex: 1, height: 3, borderRadius: 3, background: i <= step ? T.accent : "rgba(255,255,255,.1)", transition: "background .3s" }} />)}
      </div>
    </div>
  )
}

// ── Navigation Panel ──
function NavPanel({ phase, load, isPaused, onPauseToggle, onAction, step, onNext, onPrev, loading }: {
  phase: string; load: DriverLoad | null; isPaused: boolean
  onPauseToggle: () => void; onAction: (p: string) => void
  step: number; onNext: () => void; onPrev: () => void
  loading?: boolean
}) {
  const cfgs: Record<string, { dot: string; label: string; sub: string; btn: string; btnIcon: React.ReactNode; bg: string }> = {
    navigating_to_pickup: { dot: T.blue, label: "Navigating to Pickup", sub: load?.origin || "", btn: "Arrived at Pickup", btnIcon: <Package size={15} />, bg: "linear-gradient(135deg, #3b82f6, #2563eb)" },
    at_pickup: { dot: T.green, label: "At Pickup Location", sub: "Confirm load collected", btn: "Load Collected — Start Delivery", btnIcon: <Truck size={15} />, bg: T.accentGradient },
    navigating_to_dropoff: { dot: T.accent, label: "Navigating to Drop-off", sub: load?.destination || "", btn: "Arrived at Drop-off", btnIcon: <MapPin size={15} />, bg: "linear-gradient(135deg, #10b981, #059669)" },
    at_dropoff: { dot: T.purple, label: "At Delivery Location", sub: "Upload BOL & confirm", btn: "Confirm Delivery Complete", btnIcon: <CheckCircle size={15} />, bg: `linear-gradient(135deg, ${T.purple}, #7c3aed)` },
  }
  const c = cfgs[phase]
  if (!c) return null
  const showN = phase === "navigating_to_pickup" || phase === "navigating_to_dropoff"

  return (
    <div style={{
      position: "fixed", bottom: 72, left: 0, right: 0, zIndex: 40,
      background: "linear-gradient(180deg, rgba(8,13,20,.97), rgba(8,13,20,.99))",
      backdropFilter: "blur(32px)", WebkitBackdropFilter: "blur(32px)",
      borderTop: `1px solid ${T.borderMuted}`, borderRadius: "26px 26px 0 0",
      boxShadow: "0 -16px 60px rgba(0,0,0,.6)",
      paddingBottom: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}><div style={{ width: 36, height: 4, borderRadius: 4, background: "rgba(255,255,255,.18)" }} /></div>
      <div style={{ padding: "0 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot, boxShadow: `0 0 8px ${c.dot}`, animation: "driverPulse 2s infinite" }} />
              <span style={{ color: T.textPrimary, fontWeight: 700, fontSize: 14 }}>{c.label}</span>
            </div>
            <div style={{ color: T.textMuted, fontSize: 11, marginTop: 3, marginLeft: 16, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.sub}</div>
          </div>
          {showN && (
            <button onClick={onPauseToggle} style={{
              display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 11, cursor: "pointer", fontWeight: 700, fontSize: 11,
              background: isPaused ? T.accentDim : `${T.amber}18`,
              border: `1px solid ${isPaused ? T.accent + "44" : T.amber + "44"}`,
              color: isPaused ? T.accent : T.amber,
            }}>
              {isPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}{isPaused ? "Resume" : "Pause"}
            </button>
          )}
        </div>
        {showN && !isPaused && <div style={{ marginBottom: 14 }}><TurnPanel step={step} onNext={onNext} onPrev={onPrev} /></div>}
        {isPaused && (
          <div style={{ background: `${T.amber}0f`, border: `1px solid ${T.amber}33`, borderRadius: 14, padding: "12px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <PauseCircle size={20} color={T.amber} />
            <div><div style={{ color: T.amber, fontWeight: 700, fontSize: 13 }}>Navigation Paused</div><div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>Tap Resume to continue</div></div>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[
            { icon: <Truck size={11} />, val: load?.equipment || "Dry Van" },
            { icon: <Navigation size={11} />, val: load?.weight || "—" },
            { icon: <Clock size={11} />, val: "~45 min" },
          ].map(({ icon, val }, i) => (
            <div key={i} style={{ borderRadius: 12, padding: "8px 10px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: T.textMuted }}>{icon}</span>
              <span style={{ color: T.textPrimary, fontSize: 11, fontWeight: 700 }}>{val}</span>
            </div>
          ))}
        </div>
        <button onClick={() => onAction(phase)} disabled={loading} style={{
          width: "100%", padding: "16px 0", background: c.bg, border: "none", borderRadius: 18,
          color: "#fff", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center",
          justifyContent: "center", gap: 8, cursor: loading ? "wait" : "pointer",
          boxShadow: "0 6px 28px rgba(0,0,0,.35)", letterSpacing: ".02em", marginBottom: 6,
          opacity: loading ? 0.8 : 1, transition: "opacity 0.2s",
        }}>
          {loading ? <><Loader2 size={15} style={{ animation: "driverSpin 1s linear infinite" }} />Updating...</> : <>{c.btnIcon}{c.btn}</>}
        </button>
      </div>
    </div>
  )
}

// ── BOL Upload Screen ──
function BOLScreen({ load, onComplete, onSkip }: { load: DriverLoad | null; onComplete: () => void; onSkip: () => void }) {
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState(false)
  const go = () => { setUploading(true); setTimeout(() => { setUploading(false); setDone(true) }, 1800) }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "linear-gradient(160deg, #060e1a, #0a1c2e)", display: "flex", flexDirection: "column", padding: "60px 24px 40px", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 72, height: 72, borderRadius: 20, background: T.purpleDim, border: `1px solid ${T.purple}44`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
        <FileText size={36} color={T.purple} />
      </div>
      <h2 style={{ color: T.textPrimary, fontSize: 22, fontWeight: 800, marginBottom: 8, textAlign: "center" }}>Upload Bill of Lading</h2>
      <p style={{ color: T.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 1.6, marginBottom: 32 }}>
        Upload signed BOL for <strong style={{ color: T.textPrimary }}>{load?.id}</strong> before confirming.
      </p>
      {!done ? (
        <>
          <button onClick={go} disabled={uploading} style={{
            width: "100%", padding: "52px 0", borderRadius: 20, marginBottom: 14,
            background: "rgba(255,255,255,.04)", border: `2px dashed ${T.purple}55`,
            color: T.purple, fontWeight: 700, fontSize: 14,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, cursor: "pointer",
          }}>
            {uploading
              ? <><Loader2 size={28} color={T.purple} className="animate-spin" /><span>Uploading...</span></>
              : <><Upload size={28} /><span>Tap to Upload BOL</span><span style={{ fontSize: 11, color: T.textMuted, fontWeight: 400 }}>PDF, JPG, PNG supported</span></>
            }
          </button>
          <button onClick={onSkip} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>Skip for now</button>
        </>
      ) : (
        <div style={{ width: "100%" }}>
          <div style={{ background: T.greenDim, border: `1px solid ${T.green}44`, borderRadius: 14, padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <CheckCircle size={22} color={T.green} />
            <div><div style={{ color: T.green, fontWeight: 700, fontSize: 13 }}>BOL Uploaded</div><div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>Document submitted</div></div>
          </div>
          <button onClick={onComplete} style={{
            width: "100%", padding: "16px 0", borderRadius: 18,
            background: T.accentGradient, border: "none",
            color: T.bg, fontWeight: 800, fontSize: 14, cursor: "pointer",
            boxShadow: `0 6px 24px ${T.accentGlow}`,
          }}>Confirm Delivery Complete</button>
        </div>
      )}
    </div>
  )
}

// ── Delivery Complete Screen ──
function CompleteScreen({ load, onReset }: { load: DriverLoad | null; onReset: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "linear-gradient(160deg, #061a0e, #0a2415, #081a20)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ position: "relative", marginBottom: 24 }}>
        <div style={{ position: "absolute", inset: 0, background: T.green, borderRadius: "50%", opacity: 0.15, animation: "driverPing 2s infinite" }} />
        <div style={{ width: 88, height: 88, borderRadius: "50%", background: "linear-gradient(135deg, #34d399, #059669)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 40px rgba(52,211,153,.35)" }}>
          <CheckCircle size={44} color="#fff" />
        </div>
      </div>
      <h2 style={{ color: T.textPrimary, fontSize: 24, fontWeight: 800, marginBottom: 6 }}>Delivery Complete!</h2>
      <p style={{ color: T.textMuted, fontSize: 13 }}>{load?.id} · {load?.commodity || load?.shipper_name || ""}</p>
      <div style={{ width: "100%", background: `${T.accent}08`, border: `1px solid ${T.accent}22`, borderRadius: 20, padding: "18px 20px", margin: "24px 0" }}>
        <div style={{ color: T.textMuted, fontSize: 9, textTransform: "uppercase", letterSpacing: ".14em", textAlign: "center", marginBottom: 14 }}>Trip Summary</div>
        {[
          { l: "Load", v: load?.id },
          { l: "Shipper", v: load?.shipper_name },
          { l: "Pick-up", v: load?.origin },
          { l: "Drop-off", v: load?.destination },
          { l: "Weight", v: load?.weight },
          { l: "Equipment", v: load?.equipment },
        ].filter(x => x.v).map(({ l, v }) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ color: T.textMuted, fontSize: 12 }}>{l}</span>
            <span style={{ color: T.textPrimary, fontSize: 12, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, width: "100%", marginBottom: 14 }}>
        {[
          { icon: <Star size={15} />, l: "Rate" },
          { icon: <FileText size={15} />, l: "BOL" },
          { icon: <Phone size={15} />, l: "Support" },
        ].map(({ icon, l }) => (
          <button key={l} style={{ padding: "12px 0", borderRadius: 14, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.08)", color: T.textSecondary, fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            {icon}{l}
          </button>
        ))}
      </div>
      <button onClick={onReset} style={{
        width: "100%", padding: "16px 0", borderRadius: 18,
        background: T.accentGradient, border: "none",
        color: T.bg, fontWeight: 800, fontSize: 14, cursor: "pointer",
        boxShadow: `0 6px 24px ${T.accentGlow}`,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        <RotateCcw size={16} />Find Next Load
      </button>
    </div>
  )
}

// ══════════════════════════════════════════
//  MAIN HOME TAB
// ══════════════════════════════════════════
export function HomeTab() {
  const [phase, setPhase] = useState<string>("idle")
  const [loads, setLoads] = useState<DriverLoad[]>([])
  const [activeLoad, setActiveLoad] = useState<DriverLoad | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [step, setStep] = useState(0)
  const [finding, setFinding] = useState(false)
  const [loadingLoads, setLoadingLoads] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [confirmLoading, setConfirmLoading] = useState(false)

  const [driverPosition, setDriverPosition] = useState<{ lat: number; lng: number } | null>(null)

  const driverInfo = getDriverInfo()

  const isNav = ["navigating_to_pickup", "at_pickup", "navigating_to_dropoff", "at_dropoff"].includes(phase)
  const isFullscreen = ["bol_upload", "complete"].includes(phase)

  // GPS tracking
  useEffect(() => {
    if (!navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      (pos) => setDriverPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => { /* geolocation denied or unavailable */ },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  const useMapbox = MAPBOX_TOKEN && MAPBOX_TOKEN !== "pk.placeholder"

  // Fetch assigned loads from API
  const fetchLoads = useCallback(async () => {
    setLoadingLoads(true)
    try {
      const res = await driverFetch('/api/drivers/me/loads')
      if (res.ok) {
        const data = await res.json()
        const mapped: DriverLoad[] = data.map((l: DriverLoad, i: number) => ({
          ...l,
          timer: 120 - (i * 20), // stagger timers
        }))
        setLoads(mapped)
      }
    } catch {
      toast.error('Failed to fetch loads')
    } finally {
      setLoadingLoads(false)
    }
  }, [])

  // Update load status via API
  const updateStatus = useCallback(async (loadId: string, status: string) => {
    try {
      const res = await driverFetch(`/api/loads/${loadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        toast.error('Failed to update status')
        return false
      }
      return true
    } catch {
      toast.error('Network error updating status')
      return false
    }
  }, [])

  const handleConfirm = async (load: DriverLoad) => {
    setConfirmLoading(true)
    const ok = await updateStatus(load.id, "accepted")
    setConfirmLoading(false)
    if (ok) {
      setActiveLoad(load)
      setStep(0)
      setPhase("navigating_to_pickup")
    }
  }

  const handleDeny = (id: string) => {
    const n = loads.filter(l => l.id !== id)
    setLoads(n)
    if (!n.length) setPhase("idle")
  }

  const handleAction = async (p: string) => {
    const nextPhase: Record<string, string> = {
      navigating_to_pickup: "at_pickup",
      at_pickup: "navigating_to_dropoff",
      navigating_to_dropoff: "at_dropoff",
      at_dropoff: "bol_upload",
    }
    const next = nextPhase[p]
    if (!next || !activeLoad) return

    setActionLoading(true)
    // Map to DB status and update
    const dbStatus = PHASE_TO_STATUS[next]
    if (dbStatus) {
      const ok = await updateStatus(activeLoad.id, dbStatus)
      if (!ok) { setActionLoading(false); return }
    }

    setPhase(next)
    setIsPaused(false)
    setStep(0)
    setActionLoading(false)
  }

  const handleComplete = async () => {
    if (activeLoad) {
      await updateStatus(activeLoad.id, "delivered")
    }
    setPhase("complete")
  }

  const handleReset = () => {
    setPhase("idle")
    setActiveLoad(null)
    setIsPaused(false)
    setStep(0)
    fetchLoads()
  }

  const findLoad = () => {
    setFinding(true)
    fetchLoads().then(() => {
      setFinding(false)
      setPhase("selecting")
    })
  }

  if (isFullscreen) {
    if (phase === "bol_upload") return <BOLScreen load={activeLoad} onComplete={handleComplete} onSkip={() => handleComplete()} />
    return <CompleteScreen load={activeLoad} onReset={handleReset} />
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0 }}>
      {useMapbox ? (
        <DriverMap
          driverLat={driverPosition?.lat}
          driverLng={driverPosition?.lng}
          originLat={activeLoad?.origin_lat}
          originLng={activeLoad?.origin_lng}
          originCity={activeLoad?.origin?.split(",")[0]}
          destLat={activeLoad?.dest_lat}
          destLng={activeLoad?.dest_lng}
          destCity={activeLoad?.destination?.split(",")[0]}
          phase={phase}
        />
      ) : (
        <MapBG phase={phase} load={activeLoad} />
      )}

      {/* Load Selection */}
      {phase === "selecting" && (
        <>
          <div style={{ position: "absolute", top: "max(48px, env(safe-area-inset-top, 48px))", left: 12, right: 12, zIndex: 20, display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => setPhase("idle")} style={{ width: 38, height: 38, borderRadius: 12, background: T.surface, border: `1px solid ${T.borderMuted}`, backdropFilter: "blur(20px)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ChevronLeft size={17} color={T.textPrimary} />
            </button>
            <GlassPanel style={{ flex: 1, padding: "9px 14px", display: "flex", alignItems: "center", gap: 8 }}>
              <MapPin size={13} color={T.accent} />
              <span style={{ color: T.textPrimary, fontSize: 12, fontWeight: 600 }}>{loads.length} loads available</span>
            </GlassPanel>
          </div>
          <div style={{ position: "absolute", bottom: 72, left: 0, right: 0, maxHeight: "68%", overflowY: "auto", padding: "8px 14px 16px", scrollbarWidth: "none" }}>
            <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}><div style={{ width: 36, height: 4, borderRadius: 4, background: "rgba(255,255,255,.18)" }} /></div>
            <div style={{ textAlign: "center", color: T.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 12, fontWeight: 600 }}>Available Loads — Accept within timer</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {loads.map(l => <LoadCard key={l.id} load={l} onConfirm={handleConfirm} onDeny={handleDeny} loading={confirmLoading} />)}
              {loads.length === 0 && (
                <div style={{ textAlign: "center", padding: "40px 0" }}>
                  <Package size={40} color={T.textMuted} style={{ margin: "0 auto 12px" }} />
                  <div style={{ color: T.textSecondary, fontSize: 14, fontWeight: 600 }}>No loads available</div>
                  <div style={{ color: T.textMuted, fontSize: 12, marginTop: 4 }}>Pull to refresh or check back soon</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Active Navigation */}
      {isNav && (
        <>
          <div style={{ position: "absolute", top: "max(48px, env(safe-area-inset-top, 48px))", left: 12, right: 12, zIndex: 20 }}>
            <GlassPanel style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, border: `1px solid ${T.borderMuted}` }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Truck size={15} color={T.accent} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: T.textPrimary, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{activeLoad?.id} · {activeLoad?.commodity || activeLoad?.shipper_name}</div>
                <div style={{ color: T.textMuted, fontSize: 10 }}>{(phase === "navigating_to_pickup" || phase === "at_pickup") ? activeLoad?.origin : activeLoad?.destination}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={{ width: 30, height: 30, borderRadius: 9, background: T.blueDim, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><Phone size={13} color={T.blue} /></button>
                <button style={{ width: 30, height: 30, borderRadius: 9, background: T.accentDim, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><MessageSquare size={13} color={T.accent} /></button>
              </div>
            </GlassPanel>
          </div>
          <NavPanel
            phase={phase} load={activeLoad} isPaused={isPaused}
            onPauseToggle={() => setIsPaused(p => !p)} onAction={handleAction}
            step={step}
            onNext={() => setStep(p => Math.min(p + 1, TURNS.length - 1))}
            onPrev={() => setStep(p => Math.max(p - 1, 0))}
            loading={actionLoading}
          />
        </>
      )}

      {/* Idle */}
      {phase === "idle" && (
        <div style={{
          position: "fixed", bottom: 72, left: 0, right: 0, zIndex: 10,
          background: "linear-gradient(180deg, rgba(8,13,20,.97), rgba(8,13,20,.99))",
          backdropFilter: "blur(32px)", WebkitBackdropFilter: "blur(32px)",
          borderTop: `1px solid ${T.borderMuted}`, borderRadius: "28px 28px 0 0",
          boxShadow: "0 -16px 60px rgba(0,0,0,.6)",
          paddingBottom: 16,
        }}>
          <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}><div style={{ width: 36, height: 4, borderRadius: 4, background: "rgba(255,255,255,.18)" }} /></div>
          <div style={{ padding: "4px 20px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 16, background: "linear-gradient(135deg, #1a2a40, #0d1b2a)", border: `1px solid ${T.borderMuted}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                <img src="/icons/icon-192.png" alt="Myra" width={48} height={48} style={{ borderRadius: 16 }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.textPrimary, fontWeight: 800, fontSize: 15 }}>{driverInfo?.firstName} {driverInfo?.lastName || "Driver"}</div>
                <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>{driverInfo?.carrierName || "Carrier"}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
              {[
                { l: "Loads", v: String(loads.length), icon: <Package size={12} color={T.blue} /> },
                { l: "Active", v: String(loads.filter(l => l.status === "in_transit").length), icon: <Navigation size={12} color={T.accent} /> },
                { l: "Rating", v: "4.9★", icon: <Star size={12} color={T.amber} /> },
                { l: isOnline ? "Online" : "Offline", v: "", toggle: true, icon: isOnline ? <Wifi size={12} color={T.accent} /> : <WifiOff size={12} color={T.red} /> },
              ].map(({ l, v, icon, toggle }) => (
                <div key={l} onClick={toggle ? () => setIsOnline(p => !p) : undefined} style={{
                  borderRadius: 14, padding: "10px 6px", textAlign: "center",
                  background: toggle ? (isOnline ? T.accentDim : T.redDim) : "rgba(255,255,255,.04)",
                  border: `1px solid ${toggle ? (isOnline ? T.accent + "44" : T.red + "44") : "rgba(255,255,255,.07)"}`,
                  cursor: toggle ? "pointer" : "default",
                }}>
                  <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>{icon}</div>
                  {v && <div style={{ color: T.textPrimary, fontWeight: 700, fontSize: 13 }}>{v}</div>}
                  <div style={{ color: toggle ? (isOnline ? T.accent : T.red) : T.textMuted, fontSize: 9, textTransform: "uppercase", letterSpacing: ".08em", marginTop: v ? 2 : 0 }}>{l}</div>
                </div>
              ))}
            </div>
            <button onClick={findLoad} disabled={finding} style={{
              width: "100%", padding: "17px 0", borderRadius: 20,
              background: finding ? "rgba(59,130,246,.3)" : T.accentGradient,
              border: "none", color: finding ? T.accent : T.bg, fontWeight: 800, fontSize: 15,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
              cursor: finding ? "default" : "pointer",
              boxShadow: `0 8px 32px ${T.accentGlow}`,
            }}>
              {finding
                ? <><Loader2 size={18} className="animate-spin" />Finding Loads...</>
                : <><Navigation size={18} />Find a Load</>
              }
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
