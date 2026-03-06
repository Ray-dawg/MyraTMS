import { useState, useEffect } from "react";
import {
  MapPin, Navigation, Truck, Package, CheckCircle, XCircle,
  ChevronRight, ChevronLeft, Phone, MessageSquare, PauseCircle,
  PlayCircle, Clock, DollarSign, RotateCcw, ArrowUp, ArrowUpLeft,
  ArrowUpRight, Home, BarChart2, FileText, Settings, Bell, Wifi,
  WifiOff, Star, Upload, Loader2, RefreshCw, X, TrendingUp,
  ChevronDown, Camera, File, Trash2, User, Lock, LogOut,
  Eye, EyeOff, Edit3, CreditCard, AlertTriangle, Check,
  Filter, Download, Fuel, Award, BarChart, Hash, Shield,
  Maximize2, Sparkles, CornerDownRight, ThumbsUp, ThumbsDown,
  CloudRain
} from "lucide-react";

// ─── THEME ──────────────────────────────────────────────────────────────────
const T = {
  bg: "#070f1a",
  surface: "rgba(13,27,42,0.98)",
  borderMuted: "rgba(255,255,255,0.07)",
  border: "rgba(0,229,195,0.12)",
  teal: "#00e5c3", tealDim: "rgba(0,229,195,0.12)", tealGlow: "rgba(0,229,195,0.28)",
  blue: "#60a5fa", blueDim: "rgba(96,165,250,0.12)",
  amber: "#f59e0b", amberDim: "rgba(245,158,11,0.12)",
  red: "#f87171", redDim: "rgba(248,113,113,0.12)",
  green: "#34d399", greenDim: "rgba(52,211,153,0.12)",
  purple: "#a78bfa", purpleDim: "rgba(167,139,250,0.12)",
  textPrimary: "#f0f4f8",
  textSecondary: "rgba(240,244,248,0.55)",
  textMuted: "rgba(240,244,248,0.3)",
};

// ─── MOCK DATA ───────────────────────────────────────────────────────────────
const LOADS = [
  { id:"MYR-8841", pickupLocation:"Markham Food Terminal", pickupAddress:"1 Yorktech Dr, Markham ON", dropoffLocation:"Mississauga Dist. Hub", dropoffAddress:"6900 Airport Rd, Mississauga ON", pickupWindowStart:Date.now()+7200000, freightRate:485, distance:"67 km", weight:"18,400 lbs", commodity:"Frozen Produce", equipmentType:"Reefer", timer:30 },
  { id:"MYR-8842", pickupLocation:"Scarborough Warehouse", pickupAddress:"200 Milner Ave, Scarborough ON", dropoffLocation:"Brampton Cold Storage", dropoffAddress:"50 Canarctic Dr, Brampton ON", pickupWindowStart:Date.now()+10800000, freightRate:320, distance:"48 km", weight:"12,000 lbs", commodity:"Dry Goods", equipmentType:"Dry Van", timer:30 },
  { id:"MYR-8843", pickupLocation:"Ajax Agri Terminal", pickupAddress:"1265 Harwood Ave, Ajax ON", dropoffLocation:"North York Food Centre", dropoffAddress:"900 Progress Ave, Toronto ON", pickupWindowStart:Date.now()+14400000, freightRate:275, distance:"41 km", weight:"9,800 lbs", commodity:"Fresh Dairy", equipmentType:"Reefer", timer:30 },
];

const TURNS = [
  { icon:"straight", instruction:"Head north on Hwy 404", distance:"2.1 km", duration:"3 min" },
  { icon:"right",    instruction:"Take exit 37 — Hwy 407 W", distance:"12.4 km", duration:"11 min" },
  { icon:"left",     instruction:"Keep left toward Yonge St", distance:"3.8 km", duration:"5 min" },
  { icon:"straight", instruction:"Continue on Yonge St N", distance:"7.2 km", duration:"9 min" },
  { icon:"right",    instruction:"Turn right onto Steeles Ave W", distance:"5.1 km", duration:"7 min" },
  { icon:"arrive",   instruction:"Arrive at Destination", distance:"0.2 km", duration:"1 min" },
];

const TRIP_HISTORY = [
  { id:"MYR-8840", date:"Feb 26, 2026", from:"Ajax Agri Terminal", to:"North York Food Centre", distance:"41 km", earnings:275, duration:"58 min", commodity:"Fresh Dairy" },
  { id:"MYR-8839", date:"Feb 26, 2026", from:"Brampton Depot", to:"Markham Terminal", distance:"62 km", earnings:390, duration:"1h 12m", commodity:"Dry Goods" },
  { id:"MYR-8838", date:"Feb 25, 2026", from:"Toronto Distribution", to:"Oshawa Cold Storage", distance:"88 km", earnings:510, duration:"1h 38m", commodity:"Frozen Produce" },
  { id:"MYR-8837", date:"Feb 25, 2026", from:"Scarborough Warehouse", to:"Mississauga Hub", distance:"55 km", earnings:340, duration:"1h 5m", commodity:"Fresh Produce" },
  { id:"MYR-8836", date:"Feb 24, 2026", from:"Hamilton Terminal", to:"Etobicoke Cold", distance:"76 km", earnings:460, duration:"1h 22m", commodity:"Reefer Goods" },
  { id:"MYR-8835", date:"Feb 24, 2026", from:"Mississauga Hub", to:"Barrie Distribution", distance:"112 km", earnings:680, duration:"2h 8m", commodity:"Dry Van" },
  { id:"MYR-8834", date:"Feb 23, 2026", from:"Markham Food Terminal", to:"Cambridge Depot", distance:"95 km", earnings:575, duration:"1h 52m", commodity:"Frozen Produce" },
];

const WEEKLY = [
  { day:"Mon", amount:820 },{ day:"Tue", amount:1050 },{ day:"Wed", amount:680 },
  { day:"Thu", amount:1240 },{ day:"Fri", amount:950 },{ day:"Sat", amount:420 },{ day:"Sun", amount:0 },
];

const INIT_DOCS = [
  { id:"d1", name:"BOL_MYR8840.pdf", type:"bol", load:"MYR-8840", date:"Feb 26, 2026", size:"284 KB" },
  { id:"d2", name:"POD_MYR8839.jpg", type:"pod", load:"MYR-8839", date:"Feb 26, 2026", size:"1.2 MB" },
  { id:"d3", name:"BOL_MYR8838.pdf", type:"bol", load:"MYR-8838", date:"Feb 25, 2026", size:"310 KB" },
  { id:"d4", name:"POD_MYR8837.jpg", type:"pod", load:"MYR-8837", date:"Feb 25, 2026", size:"980 KB" },
  { id:"d5", name:"Fuel_Feb24.pdf",  type:"fuel", load:"—",       date:"Feb 24, 2026", size:"128 KB" },
];

const DOC_TYPES = [
  { key:"bol",   label:"Bill of Lading",   color:T.teal,   icon:"bol"  },
  { key:"pod",   label:"Proof of Delivery",color:T.green,  icon:"pod"  },
  { key:"fuel",  label:"Fuel Receipt",     color:T.amber,  icon:"fuel" },
  { key:"other", label:"Other Document",   color:T.blue,   icon:"other"},
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmt = ts => new Date(ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:true});

const GlassPanel = ({ children, style={} }) => (
  <div style={{ background:T.surface, backdropFilter:"blur(28px) saturate(160%)", border:`1px solid ${T.borderMuted}`, borderRadius:20, boxShadow:"0 8px 40px rgba(0,0,0,0.45)", ...style }}>{children}</div>
);

const Pill = ({ children, color=T.teal }) => (
  <span style={{ background:`${color}22`, color, border:`1px solid ${color}44`, borderRadius:99, padding:"2px 8px", fontSize:10, fontWeight:700, letterSpacing:"0.04em", textTransform:"uppercase" }}>{children}</span>
);

const Divider = () => <div style={{ height:1, background:"rgba(255,255,255,0.06)", margin:"0 16px" }}/>;

const Toggle = ({ on, set }) => (
  <button onClick={()=>set(p=>!p)} style={{ width:44, height:26, borderRadius:13, position:"relative", cursor:"pointer", border:"none", background:on?`linear-gradient(135deg,${T.teal},#00b4a0)`:"rgba(255,255,255,0.12)", transition:"background 0.25s", flexShrink:0 }}>
    <div style={{ position:"absolute", top:3, left:on?20:3, width:20, height:20, borderRadius:"50%", background:"#fff", transition:"left 0.25s", boxShadow:"0 2px 6px rgba(0,0,0,0.3)" }}/>
  </button>
);

function TurnIcon({ type, size=18 }) {
  const s = { color:T.teal };
  if(type==="right")  return <ArrowUpRight size={size} style={s}/>;
  if(type==="left")   return <ArrowUpLeft  size={size} style={s}/>;
  if(type==="arrive") return <MapPin size={size} style={{ color:T.green }}/>;
  return <ArrowUp size={size} style={s}/>;
}

function DocIcon({ type, size=14 }) {
  const dt = DOC_TYPES.find(d=>d.key===type)||DOC_TYPES[3];
  if(type==="bol")  return <FileText size={size} color={dt.color}/>;
  if(type==="pod")  return <CheckCircle size={size} color={dt.color}/>;
  if(type==="fuel") return <Fuel size={size} color={dt.color}/>;
  return <File size={size} color={dt.color}/>;
}

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
const NAV_TABS = [
  { key:"home",     icon:<Home size={20}/>,     label:"Home"     },
  { key:"earnings", icon:<BarChart2 size={20}/>, label:"Earnings" },
  { key:"docs",     icon:<FileText size={20}/>,  label:"Docs"     },
  { key:"settings", icon:<Settings size={20}/>,  label:"Settings" },
];

function BottomNav({ active, onChange }) {
  return (
    <div style={{ position:"absolute", bottom:0, left:0, right:0, zIndex:100, background:"linear-gradient(180deg,rgba(6,14,26,0.97) 0%,rgba(7,15,26,0.99) 100%)", backdropFilter:"blur(32px)", borderTop:"1px solid rgba(255,255,255,0.07)", paddingBottom:20, paddingTop:10, display:"flex", justifyContent:"space-around" }}>
      {NAV_TABS.map(({key,icon,label})=>(
        <button key={key} onClick={()=>onChange(key)} style={{ background:"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4, padding:"4px 14px" }}>
          <span style={{ color:active===key?T.teal:T.textMuted }}>{icon}</span>
          <span style={{ color:active===key?T.teal:T.textMuted, fontSize:10, fontWeight:600 }}>{label}</span>
          {active===key && <div style={{ width:16, height:3, borderRadius:2, background:T.teal }}/>}
        </button>
      ))}
    </div>
  );
}

// scrollable page wrapper
const Page = ({ children }) => (
  <div style={{ position:"absolute", top:44, left:0, right:0, bottom:70, overflowY:"auto", scrollbarWidth:"none" }}>
    {children}
  </div>
);

// ══════════════════════════════════════════
//  TAB: EARNINGS
// ══════════════════════════════════════════
function EarningsTab() {
  const [period, setPeriod] = useState("week");
  const [expanded, setExpanded] = useState(null);
  const maxBar = Math.max(...WEEKLY.map(d=>d.amount), 1);
  const weekTotal = WEEKLY.reduce((s,d)=>s+d.amount,0);
  const stats = {
    week:  { total:weekTotal, loads:7,  km:"441 km",   avg:"$751"  },
    month: { total:14820,     loads:31, km:"2,108 km", avg:"$478"  },
  };
  const s = stats[period];

  return (
    <Page>
      <div style={{ padding:"16px 18px 32px" }}>
        {/* Header */}
        <div style={{ marginBottom:20 }}>
          <div style={{ color:T.textMuted, fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Driver Earnings</div>
          <div style={{ color:T.textPrimary, fontSize:22, fontWeight:800 }}>Marcus Williams</div>
          <div style={{ color:T.textMuted, fontSize:12, marginTop:2 }}>Thursday, February 27, 2026</div>
        </div>

        {/* Today hero */}
        <div style={{ borderRadius:22, padding:"20px", marginBottom:16, background:"linear-gradient(135deg,rgba(0,229,195,0.14),rgba(0,180,160,0.07))", border:`1px solid ${T.border}` }}>
          <div style={{ color:T.textMuted, fontSize:10, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:6 }}>Today's Earnings</div>
          <div style={{ display:"flex", alignItems:"flex-end", gap:8, marginBottom:14 }}>
            <span style={{ color:T.teal, fontSize:40, fontWeight:900, lineHeight:1 }}>$1,240</span>
            <span style={{ color:T.teal, fontSize:13, fontWeight:600, marginBottom:5, opacity:0.6 }}>CAD</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            {[{l:"Loads",v:"7"},{l:"Distance",v:"412 km"},{l:"Hours",v:"9.2 h"}].map(({l,v})=>(
              <div key={l} style={{ textAlign:"center" }}>
                <div style={{ color:T.textPrimary, fontWeight:700, fontSize:14 }}>{v}</div>
                <div style={{ color:T.textMuted, fontSize:10, marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Period toggle */}
        <div style={{ display:"flex", gap:6, marginBottom:16 }}>
          {[["week","This Week"],["month","This Month"]].map(([k,l])=>(
            <button key={k} onClick={()=>setPeriod(k)} style={{ flex:1, padding:"10px 0", borderRadius:12, cursor:"pointer", fontWeight:700, fontSize:12, background:period===k?T.teal:"rgba(255,255,255,0.05)", border:period===k?"none":"1px solid rgba(255,255,255,0.08)", color:period===k?T.bg:T.textSecondary }}>{l}</button>
          ))}
        </div>

        {/* Bar chart */}
        <GlassPanel style={{ padding:"16px 16px 12px", marginBottom:16 }}>
          <div style={{ color:T.textSecondary, fontSize:11, fontWeight:600, marginBottom:14 }}>Daily — This Week</div>
          <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:76, marginBottom:8 }}>
            {WEEKLY.map(({day,amount})=>{
              const h = Math.max((amount/maxBar)*70,3);
              const isToday = day==="Thu";
              return (
                <div key={day} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4, height:"100%", justifyContent:"flex-end" }}>
                  <div style={{ width:"100%", borderRadius:"5px 5px 0 0", height:h, background:isToday?`linear-gradient(180deg,${T.teal},#00b4a0)`:"rgba(255,255,255,0.1)" }}/>
                </div>
              );
            })}
          </div>
          <div style={{ display:"flex", gap:6 }}>
            {WEEKLY.map(({day})=>(
              <div key={day} style={{ flex:1, textAlign:"center", color:day==="Thu"?T.teal:T.textMuted, fontSize:10, fontWeight:day==="Thu"?700:500 }}>{day}</div>
            ))}
          </div>
        </GlassPanel>

        {/* Stats grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
          {[
            {icon:<DollarSign size={14} color={T.teal}/>,  label:"Total Earnings", val:`$${s.total.toLocaleString()}`},
            {icon:<Package size={14} color={T.blue}/>,     label:"Total Loads",    val:String(s.loads)},
            {icon:<Navigation size={14} color={T.amber}/>, label:"Distance",       val:s.km},
            {icon:<BarChart size={14} color={T.purple}/>,  label:"Avg Per Load",   val:s.avg},
          ].map(({icon,label,val})=>(
            <GlassPanel key={label} style={{ padding:"14px 16px" }}>
              <div style={{ width:30,height:30,borderRadius:9,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8 }}>{icon}</div>
              <div style={{ color:T.textPrimary, fontWeight:800, fontSize:18 }}>{val}</div>
              <div style={{ color:T.textMuted, fontSize:11, marginTop:2 }}>{label}</div>
            </GlassPanel>
          ))}
        </div>

        {/* Trip history */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
          <span style={{ color:T.textPrimary, fontWeight:700, fontSize:15 }}>Trip History</span>
          <span style={{ color:T.textMuted, fontSize:12, display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}><Filter size={12}/>Filter</span>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {TRIP_HISTORY.map(trip=>(
            <GlassPanel key={trip.id} style={{ overflow:"hidden", border:"1px solid rgba(255,255,255,0.06)" }}>
              <div onClick={()=>setExpanded(expanded===trip.id?null:trip.id)} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ width:38,height:38,borderRadius:12,background:T.tealDim,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><Truck size={17} color={T.teal}/></div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:T.textPrimary, fontWeight:700, fontSize:12, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{trip.from} → {trip.to}</div>
                  <div style={{ color:T.textMuted, fontSize:10, marginTop:3 }}>{trip.date} · {trip.duration}</div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={{ color:T.teal, fontWeight:800, fontSize:15 }}>${trip.earnings}</div>
                  <div style={{ color:T.textMuted, fontSize:10, marginTop:2 }}>{trip.distance}</div>
                </div>
                <ChevronDown size={14} color={T.textMuted} style={{ flexShrink:0, transform:expanded===trip.id?"rotate(180deg)":"none", transition:"transform 0.25s" }}/>
              </div>
              {expanded===trip.id&&(
                <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", padding:"12px 16px" }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                    {[{l:"Load ID",v:trip.id},{l:"Commodity",v:trip.commodity},{l:"Distance",v:trip.distance},{l:"Duration",v:trip.duration}].map(({l,v})=>(
                      <div key={l}><div style={{ color:T.textMuted,fontSize:9,textTransform:"uppercase",letterSpacing:"0.1em" }}>{l}</div><div style={{ color:T.textPrimary,fontSize:12,fontWeight:600,marginTop:2 }}>{v}</div></div>
                    ))}
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button style={{ flex:1,padding:"9px 0",borderRadius:10,background:T.blueDim,border:`1px solid ${T.blue}33`,color:T.blue,fontSize:11,fontWeight:700,cursor:"pointer" }}>View BOL</button>
                    <button style={{ flex:1,padding:"9px 0",borderRadius:10,background:T.tealDim,border:`1px solid ${T.teal}33`,color:T.teal,fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5 }}><Download size={12}/>Receipt</button>
                  </div>
                </div>
              )}
            </GlassPanel>
          ))}
        </div>
      </div>
    </Page>
  );
}

// ══════════════════════════════════════════
//  TAB: DOCS
// ══════════════════════════════════════════
function DocsTab() {
  const [docs, setDocs] = useState(INIT_DOCS);
  const [uploading, setUploading] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [deleteId, setDeleteId] = useState(null);

  const filtered = filterType==="all" ? docs : docs.filter(d=>d.type===filterType);

  const startUpload = type => { setUploading(type); setUploadDone(false); setUploadProgress(0); };

  const doUpload = () => {
    let p = 0;
    const iv = setInterval(()=>{
      p += Math.random()*18+8;
      setUploadProgress(Math.min(p,100));
      if(p>=100){
        clearInterval(iv);
        const dt = DOC_TYPES.find(d=>d.key===uploading)||DOC_TYPES[3];
        const num = Math.floor(9820+Math.random()*80);
        setDocs(prev=>[{ id:`d${Date.now()}`, name:`${uploading.toUpperCase()}_MYR${num}.pdf`, type:uploading, load:`MYR-${num}`, date:"Feb 27, 2026", size:`${Math.floor(200+Math.random()*800)} KB` }, ...prev]);
        setUploadDone(true);
      }
    }, 120);
  };

  const closeModal = () => { setUploading(null); setUploadDone(false); setUploadProgress(0); };

  return (
    <Page>
      <div style={{ padding:"16px 18px 32px" }}>
        <div style={{ marginBottom:20 }}>
          <div style={{ color:T.textMuted, fontSize:10, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Document Vault</div>
          <div style={{ color:T.textPrimary, fontSize:22, fontWeight:800 }}>My Documents</div>
          <div style={{ color:T.textMuted, fontSize:12, marginTop:2 }}>{docs.length} files stored</div>
        </div>

        {/* Upload grid */}
        <div style={{ color:T.textSecondary, fontSize:12, fontWeight:600, marginBottom:10 }}>Upload New Document</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
          {DOC_TYPES.map(({key,label,color})=>(
            <button key={key} onClick={()=>startUpload(key)} style={{ padding:"14px 12px", borderRadius:16, cursor:"pointer", background:`${color}10`, border:`1px solid ${color}30`, display:"flex", flexDirection:"column", alignItems:"flex-start", gap:8 }}>
              <div style={{ width:34,height:34,borderRadius:10,background:`${color}20`,display:"flex",alignItems:"center",justifyContent:"center",color }}><DocIcon type={key} size={15}/></div>
              <div style={{ color:T.textPrimary, fontSize:12, fontWeight:700 }}>{label}</div>
              <div style={{ color, fontSize:10, fontWeight:600, display:"flex", alignItems:"center", gap:4 }}><Upload size={10}/>Upload</div>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display:"flex", gap:6, marginBottom:16, overflowX:"auto", scrollbarWidth:"none" }}>
          {[{k:"all",l:`All (${docs.length})`},{k:"bol",l:`BOL (${docs.filter(d=>d.type==="bol").length})`},{k:"pod",l:`POD (${docs.filter(d=>d.type==="pod").length})`},{k:"fuel",l:`Fuel (${docs.filter(d=>d.type==="fuel").length})`},{k:"other",l:`Other (${docs.filter(d=>d.type==="other").length})`}].map(({k,l})=>(
            <button key={k} onClick={()=>setFilterType(k)} style={{ padding:"7px 14px", borderRadius:20, cursor:"pointer", flexShrink:0, background:filterType===k?T.teal:"rgba(255,255,255,0.06)", border:filterType===k?"none":"1px solid rgba(255,255,255,0.09)", color:filterType===k?T.bg:T.textSecondary, fontSize:11, fontWeight:700 }}>{l}</button>
          ))}
        </div>

        {/* Doc list */}
        {filtered.length===0 ? (
          <GlassPanel style={{ padding:"40px 0", textAlign:"center" }}><FileText size={30} color={T.textMuted} style={{ margin:"0 auto 10px",display:"block" }}/><div style={{ color:T.textMuted,fontSize:13 }}>No documents here yet</div></GlassPanel>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {filtered.map(doc=>{
              const dt = DOC_TYPES.find(d=>d.key===doc.type)||DOC_TYPES[3];
              return (
                <GlassPanel key={doc.id} style={{ padding:"14px 16px", display:"flex", alignItems:"center", gap:12, border:"1px solid rgba(255,255,255,0.06)" }}>
                  <div style={{ width:40,height:40,borderRadius:12,background:`${dt.color}18`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><DocIcon type={doc.type} size={16}/></div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ color:T.textPrimary, fontSize:12, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{doc.name}</div>
                    <div style={{ color:T.textMuted, fontSize:10, marginTop:3 }}>{doc.load} · {doc.date} · {doc.size}</div>
                    <div style={{ marginTop:5 }}><Pill color={dt.color}>{dt.label}</Pill></div>
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button style={{ width:30,height:30,borderRadius:9,background:T.blueDim,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Download size={13} color={T.blue}/></button>
                    <button onClick={()=>setDeleteId(doc.id)} style={{ width:30,height:30,borderRadius:9,background:T.redDim,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Trash2 size={13} color={T.red}/></button>
                  </div>
                </GlassPanel>
              );
            })}
          </div>
        )}
      </div>

      {/* Upload modal */}
      {uploading && (
        <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.78)", display:"flex", alignItems:"flex-end", zIndex:200 }}>
          <div style={{ width:"100%", background:T.bg, borderRadius:"24px 24px 0 0", padding:"24px 22px 48px", border:`1px solid ${T.borderMuted}`, borderBottom:"none" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
              <div>
                <div style={{ color:T.textMuted, fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em" }}>Upload Document</div>
                <div style={{ color:T.textPrimary, fontWeight:800, fontSize:18 }}>{DOC_TYPES.find(d=>d.key===uploading)?.label}</div>
              </div>
              <button onClick={closeModal} style={{ background:"rgba(255,255,255,0.08)", border:"none", width:34,height:34,borderRadius:10,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><X size={16} color={T.textPrimary}/></button>
            </div>
            {!uploadDone ? (
              <>
                {uploadProgress > 0 ? (
                  <div style={{ marginBottom:20 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                      <span style={{ color:T.textSecondary, fontSize:12 }}>Uploading...</span>
                      <span style={{ color:T.teal, fontSize:12, fontWeight:700 }}>{Math.round(uploadProgress)}%</span>
                    </div>
                    <div style={{ height:6, borderRadius:3, background:"rgba(255,255,255,0.1)" }}>
                      <div style={{ height:"100%", borderRadius:3, width:`${uploadProgress}%`, background:`linear-gradient(90deg,${T.teal},#00b4a0)`, transition:"width 0.1s" }}/>
                    </div>
                  </div>
                ) : (
                  <button onClick={doUpload} style={{ width:"100%",padding:"52px 0",borderRadius:20,marginBottom:14,background:"rgba(255,255,255,0.03)",border:`2px dashed ${T.teal}44`,color:T.teal,fontWeight:700,fontSize:14,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,cursor:"pointer" }}>
                    <Upload size={28}/><span>Tap to Select File</span><span style={{ fontSize:11,color:T.textMuted,fontWeight:400 }}>PDF, JPG, PNG — Max 25 MB</span>
                  </button>
                )}
                {uploadProgress === 0 && (
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={doUpload} style={{ flex:1,padding:"13px 0",borderRadius:14,background:T.tealDim,border:`1px solid ${T.teal}33`,color:T.teal,fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}><Camera size={14}/>Camera</button>
                    <button onClick={doUpload} style={{ flex:1,padding:"13px 0",borderRadius:14,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",color:T.textSecondary,fontWeight:700,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}><File size={14}/>Files</button>
                  </div>
                )}
              </>
            ) : (
              <div>
                <div style={{ background:T.greenDim, border:`1px solid ${T.green}44`, borderRadius:16, padding:"16px 20px", display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
                  <CheckCircle size={24} color={T.green}/>
                  <div><div style={{ color:T.green,fontWeight:700,fontSize:14 }}>Upload Successful</div><div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>Saved to your document vault</div></div>
                </div>
                <button onClick={closeModal} style={{ width:"100%",padding:"15px 0",borderRadius:16,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:14,cursor:"pointer" }}>Done</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.78)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:"0 24px" }}>
          <GlassPanel style={{ padding:"28px", width:"100%" }}>
            <div style={{ width:52,height:52,borderRadius:16,background:T.redDim,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px" }}><Trash2 size={24} color={T.red}/></div>
            <div style={{ color:T.textPrimary,fontWeight:800,fontSize:18,textAlign:"center",marginBottom:8 }}>Delete Document?</div>
            <div style={{ color:T.textMuted,fontSize:13,textAlign:"center",marginBottom:22 }}>This action cannot be undone.</div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setDeleteId(null)} style={{ flex:1,padding:"13px 0",borderRadius:14,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",color:T.textSecondary,fontWeight:700,fontSize:13,cursor:"pointer" }}>Cancel</button>
              <button onClick={()=>{ setDocs(p=>p.filter(d=>d.id!==deleteId)); setDeleteId(null); }} style={{ flex:1,padding:"13px 0",borderRadius:14,background:T.redDim,border:`1px solid ${T.red}44`,color:T.red,fontWeight:800,fontSize:13,cursor:"pointer" }}>Delete</button>
            </div>
          </GlassPanel>
        </div>
      )}
    </Page>
  );
}

// ══════════════════════════════════════════
//  TAB: SETTINGS
// ══════════════════════════════════════════
function SettingsTab({ onLogout }) {
  const [profile, setProfile] = useState({ name:"Marcus Williams", email:"marcus.w@myraai.ca", phone:"+1 (416) 555-0182", truck:"Kenworth T680", plate:"ON-482-JHK", license:"D0482-19820", carrier:"Williams Freight Inc." });
  const [editField, setEditField] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pw, setPw] = useState({ current:"", newPw:"", confirm:"" });
  const [pwState, setPwState] = useState("idle"); // idle|saving|done|error
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [notifs, setNotifs] = useState({ push:true, weather:true, ai:true, dark:true });

  const save = () => { setProfile(p=>({...p,[editField]:editVal})); setEditField(null); };

  const savePw = () => {
    if(!pw.newPw || pw.newPw!==pw.confirm){ setPwState("error"); setTimeout(()=>setPwState("idle"),2000); return; }
    setPwState("saving");
    setTimeout(()=>{ setPwState("done"); setPw({current:"",newPw:"",confirm:""}); setTimeout(()=>setPwState("idle"),2500); },1500);
  };

  const profileFields = [
    { key:"name",    label:"Full Name",        icon:<User size={14} color={T.teal}/> },
    { key:"email",   label:"Email Address",    icon:<Hash size={14} color={T.blue}/> },
    { key:"phone",   label:"Phone Number",     icon:<Phone size={14} color={T.green}/> },
    { key:"truck",   label:"Truck Model",      icon:<Truck size={14} color={T.amber}/> },
    { key:"plate",   label:"Licence Plate",    icon:<CreditCard size={14} color={T.purple}/> },
    { key:"license", label:"Driver's Licence", icon:<Shield size={14} color={T.blue}/> },
    { key:"carrier", label:"Carrier Name",     icon:<Award size={14} color={T.teal}/> },
  ];

  return (
    <Page>
      <div style={{ padding:"16px 18px 32px" }}>
        <div style={{ marginBottom:24 }}>
          <div style={{ color:T.textMuted,fontSize:10,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4 }}>Account</div>
          <div style={{ color:T.textPrimary,fontSize:22,fontWeight:800 }}>Settings</div>
        </div>

        {/* Avatar */}
        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",marginBottom:28 }}>
          <div style={{ position:"relative",marginBottom:14 }}>
            <div style={{ width:80,height:80,borderRadius:24,background:`linear-gradient(135deg,${T.teal}40,${T.blue}40)`,border:`2px solid ${T.teal}44`,display:"flex",alignItems:"center",justifyContent:"center" }}><User size={38} color={T.teal}/></div>
            <button style={{ position:"absolute",bottom:-4,right:-4,width:26,height:26,borderRadius:9,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Camera size={13} color={T.bg}/></button>
          </div>
          <div style={{ color:T.textPrimary,fontWeight:800,fontSize:17 }}>{profile.name}</div>
          <div style={{ color:T.textMuted,fontSize:12,marginTop:3 }}>{profile.carrier}</div>
          <div style={{ marginTop:6 }}><Pill color={T.teal}>Active Driver</Pill></div>
        </div>

        {/* Profile fields */}
        <div style={{ color:T.textSecondary,fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12 }}>Profile Information</div>
        <GlassPanel style={{ overflow:"hidden", marginBottom:22 }}>
          {profileFields.map(({key,label,icon},i)=>(
            <div key={key}>
              {i>0&&<Divider/>}
              <div style={{ padding:"13px 16px",display:"flex",alignItems:"center",gap:12 }}>
                <div style={{ width:30,height:30,borderRadius:9,background:"rgba(255,255,255,0.05)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{icon}</div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ color:T.textMuted,fontSize:10,textTransform:"uppercase",letterSpacing:"0.08em" }}>{label}</div>
                  {editField===key
                    ? <input value={editVal} onChange={e=>setEditVal(e.target.value)} style={{ color:T.textPrimary,fontSize:13,fontWeight:600,background:"transparent",border:"none",outline:"none",width:"100%",marginTop:3 }} autoFocus/>
                    : <div style={{ color:T.textPrimary,fontSize:13,fontWeight:600,marginTop:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{profile[key]}</div>
                  }
                </div>
                {editField===key
                  ? <div style={{ display:"flex",gap:6 }}>
                      <button onClick={save} style={{ width:28,height:28,borderRadius:8,background:T.tealDim,border:`1px solid ${T.teal}44`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Check size={13} color={T.teal}/></button>
                      <button onClick={()=>setEditField(null)} style={{ width:28,height:28,borderRadius:8,background:T.redDim,border:`1px solid ${T.red}44`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><X size={13} color={T.red}/></button>
                    </div>
                  : <button onClick={()=>{setEditField(key);setEditVal(profile[key]);}} style={{ width:28,height:28,borderRadius:8,background:"rgba(255,255,255,0.06)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Edit3 size={13} color={T.textMuted}/></button>
                }
              </div>
            </div>
          ))}
        </GlassPanel>

        {/* Security */}
        <div style={{ color:T.textSecondary,fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12 }}>Security</div>
        <GlassPanel style={{ padding:"16px", marginBottom:22 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14 }}>
            <div style={{ width:30,height:30,borderRadius:9,background:T.purpleDim,display:"flex",alignItems:"center",justifyContent:"center" }}><Lock size={14} color={T.purple}/></div>
            <span style={{ color:T.textPrimary,fontWeight:700,fontSize:13 }}>Change Password</span>
          </div>
          {[{k:"current",l:"Current Password"},{k:"newPw",l:"New Password"},{k:"confirm",l:"Confirm Password"}].map(({k,l},i)=>(
            <div key={k} style={{ marginBottom:10 }}>
              <div style={{ color:T.textMuted,fontSize:10,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5 }}>{l}</div>
              <div style={{ background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.09)",borderRadius:12,padding:"11px 14px",display:"flex",alignItems:"center",gap:8 }}>
                <input type={showPw?"text":"password"} value={pw[k]} onChange={e=>setPw(p=>({...p,[k]:e.target.value}))} placeholder="••••••••" style={{ flex:1,background:"transparent",border:"none",outline:"none",color:T.textPrimary,fontSize:13 }}/>
                {i===0&&<button onClick={()=>setShowPw(p=>!p)} style={{ background:"none",border:"none",cursor:"pointer" }}>{showPw?<EyeOff size={14} color={T.textMuted}/>:<Eye size={14} color={T.textMuted}/>}</button>}
              </div>
            </div>
          ))}
          {pwState==="error"&&<div style={{ color:T.red,fontSize:12,marginBottom:10,display:"flex",alignItems:"center",gap:6 }}><AlertTriangle size={13}/>Passwords don't match</div>}
          <button onClick={savePw} style={{ width:"100%",padding:"13px 0",borderRadius:14,marginTop:4,background:pwState==="done"?T.greenDim:`linear-gradient(135deg,${T.purple},#7c3aed)`,border:pwState==="done"?`1px solid ${T.green}44`:"none",color:pwState==="done"?T.green:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7 }}>
            {pwState==="saving"?<><Loader2 size={15} style={{ animation:"spin 1s linear infinite" }}/>Saving...</>
             :pwState==="done"?<><CheckCircle size={15}/>Password Updated</>
             :<><Lock size={15}/>Update Password</>}
          </button>
        </GlassPanel>

        {/* Preferences */}
        <div style={{ color:T.textSecondary,fontSize:11,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12 }}>Preferences</div>
        <GlassPanel style={{ overflow:"hidden", marginBottom:22 }}>
          {[
            {k:"push",    l:"Push Notifications",     s:"Load alerts & updates"},
            {k:"weather", l:"Weather Alerts",          s:"Route weather warnings"},
            {k:"ai",      l:"AI Route Suggestions",    s:"Intelligent optimization"},
            {k:"dark",    l:"Dark Mode",               s:"App appearance"},
          ].map(({k,l,s},i)=>(
            <div key={k}>
              {i>0&&<Divider/>}
              <div style={{ padding:"13px 16px",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
                <div><div style={{ color:T.textPrimary,fontSize:13,fontWeight:600 }}>{l}</div><div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>{s}</div></div>
                <Toggle on={notifs[k]} set={v=>setNotifs(p=>({...p,[k]:v(p[k])}))}/>
              </div>
            </div>
          ))}
        </GlassPanel>

        {/* App info + logout */}
        <button onClick={()=>setLogoutConfirm(true)} style={{ width:"100%",padding:"15px 0",borderRadius:18,background:T.redDim,border:`1px solid ${T.red}33`,color:T.red,fontWeight:800,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:10 }}>
          <LogOut size={16}/>Sign Out
        </button>
        <div style={{ color:T.textMuted,fontSize:10,textAlign:"center" }}>Myra AI Driver App v2.4.1 · Build 2026.02.27</div>
      </div>

      {/* Logout confirm */}
      {logoutConfirm&&(
        <div style={{ position:"absolute",inset:0,background:"rgba(0,0,0,0.78)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:"0 24px" }}>
          <GlassPanel style={{ padding:"28px" }}>
            <div style={{ width:56,height:56,borderRadius:18,background:T.redDim,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px" }}><LogOut size={26} color={T.red}/></div>
            <div style={{ color:T.textPrimary,fontWeight:800,fontSize:20,textAlign:"center",marginBottom:8 }}>Sign Out?</div>
            <div style={{ color:T.textMuted,fontSize:13,textAlign:"center",lineHeight:1.6,marginBottom:24 }}>You'll need to sign in again to access your account.</div>
            <div style={{ display:"flex",gap:10 }}>
              <button onClick={()=>setLogoutConfirm(false)} style={{ flex:1,padding:"14px 0",borderRadius:14,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",color:T.textSecondary,fontWeight:700,fontSize:13,cursor:"pointer" }}>Cancel</button>
              <button onClick={onLogout} style={{ flex:1,padding:"14px 0",borderRadius:14,background:T.redDim,border:`1px solid ${T.red}44`,color:T.red,fontWeight:800,fontSize:13,cursor:"pointer" }}>Sign Out</button>
            </div>
          </GlassPanel>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </Page>
  );
}

// ══════════════════════════════════════════
//  LOGIN SCREEN
// ══════════════════════════════════════════
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pw, setPw]       = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]     = useState("");

  const go = () => {
    if(!email||!pw){ setErr("Please fill in all fields."); return; }
    setErr(""); setLoading(true);
    setTimeout(()=>{ setLoading(false); onLogin(); },1600);
  };

  return (
    <div style={{ position:"absolute",inset:0,background:`linear-gradient(160deg,#061220,#091a2e,#0a1f30)`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 28px" }}>
      <div style={{ marginBottom:36,textAlign:"center" }}>
        <div style={{ width:72,height:72,borderRadius:22,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",boxShadow:`0 8px 36px ${T.tealGlow}` }}><Truck size={36} color={T.bg}/></div>
        <div style={{ color:T.textPrimary,fontSize:26,fontWeight:900,letterSpacing:"-0.02em" }}>Myra AI</div>
        <div style={{ color:T.textMuted,fontSize:13,marginTop:4 }}>Driver Portal</div>
      </div>
      <div style={{ width:"100%" }}>
        <div style={{ marginBottom:12 }}>
          <div style={{ color:T.textMuted,fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6 }}>Email Address</div>
          <div style={{ background:"rgba(255,255,255,0.05)",border:`1px solid ${err&&!email?T.red+"66":"rgba(255,255,255,0.1)"}`,borderRadius:14,padding:"13px 16px",display:"flex",gap:10,alignItems:"center" }}>
            <Hash size={15} color={T.textMuted}/>
            <input type="email" value={email} onChange={e=>{setEmail(e.target.value);setErr("");}} placeholder="you@myraai.ca" style={{ flex:1,background:"transparent",border:"none",outline:"none",color:T.textPrimary,fontSize:14 }}/>
          </div>
        </div>
        <div style={{ marginBottom:err?8:20 }}>
          <div style={{ color:T.textMuted,fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6 }}>Password</div>
          <div style={{ background:"rgba(255,255,255,0.05)",border:`1px solid ${err&&!pw?T.red+"66":"rgba(255,255,255,0.1)"}`,borderRadius:14,padding:"13px 16px",display:"flex",gap:10,alignItems:"center" }}>
            <Lock size={15} color={T.textMuted}/>
            <input type={showPw?"text":"password"} value={pw} onChange={e=>{setPw(e.target.value);setErr("");}} placeholder="••••••••••" style={{ flex:1,background:"transparent",border:"none",outline:"none",color:T.textPrimary,fontSize:14 }}/>
            <button onClick={()=>setShowPw(p=>!p)} style={{ background:"none",border:"none",cursor:"pointer" }}>{showPw?<EyeOff size={15} color={T.textMuted}/>:<Eye size={15} color={T.textMuted}/>}</button>
          </div>
        </div>
        {err&&<div style={{ color:T.red,fontSize:12,marginBottom:16,display:"flex",alignItems:"center",gap:6 }}><AlertTriangle size={13}/>{err}</div>}
        <button onClick={go} disabled={loading} style={{ width:"100%",padding:"17px 0",borderRadius:18,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",boxShadow:`0 8px 32px ${T.tealGlow}`,display:"flex",alignItems:"center",justifyContent:"center",gap:8,opacity:loading?.8:1 }}>
          {loading?<><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/>Signing in...</>:"Sign In"}
        </button>
        <div style={{ textAlign:"center",marginTop:16 }}>
          <button style={{ background:"none",border:"none",color:T.teal,fontSize:12,cursor:"pointer",textDecoration:"underline" }}>Forgot password?</button>
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ══════════════════════════════════════════
//  HOME TAB (Map + full nav flow)
// ══════════════════════════════════════════
function MapBG({ phase, load }) {
  const rc = phase.includes("pickup") ? T.blue : T.teal;
  return (
    <div style={{ position:"absolute",inset:0,overflow:"hidden",background:"linear-gradient(155deg,#061220,#091a2e,#0a1f30)" }}>
      <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:.07 }}>
        <defs><pattern id="g2" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M 48 0 L 0 0 0 48" fill="none" stroke={T.teal} strokeWidth=".5"/></pattern></defs>
        <rect width="100%" height="100%" fill="url(#g2)"/>
      </svg>
      <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%",opacity:.18 }}>
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#fff" strokeWidth="9"/>
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#091a2e" strokeWidth="7"/>
        <line x1="0" y1="52%" x2="100%" y2="45%" stroke="#fff" strokeWidth="1.5" strokeDasharray="22,16"/>
        <line x1="28%" y1="0" x2="42%" y2="100%" stroke="#fff" strokeWidth="6"/>
        <line x1="28%" y1="0" x2="42%" y2="100%" stroke="#091a2e" strokeWidth="4"/>
      </svg>
      {(phase==="navigating_to_pickup"||phase==="navigating_to_dropoff")&&(
        <svg style={{ position:"absolute",inset:0,width:"100%",height:"100%" }}>
          <path d="M 52 75% Q 28% 52% 76% 28%" stroke={rc} strokeWidth="3.5" fill="none" strokeDasharray="9,6" opacity=".65">
            <animate attributeName="stroke-dashoffset" from="0" to="-60" dur="1.5s" repeatCount="indefinite"/>
          </path>
        </svg>
      )}
      {load&&(phase==="navigating_to_pickup"||phase==="selecting")&&(
        <div style={{ position:"absolute",left:"26%",top:"34%",display:"flex",flexDirection:"column",alignItems:"center" }}>
          <div style={{ width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#60a5fa,#3b82f6)",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 16px rgba(96,165,250,.5)" }}><Package size={13} color="#fff"/></div>
          <div style={{ width:1,height:12,background:"#60a5fa" }}/><div style={{ width:6,height:6,borderRadius:"50%",background:"#60a5fa" }}/>
        </div>
      )}
      {load&&(phase==="navigating_to_dropoff"||phase==="at_dropoff")&&(
        <div style={{ position:"absolute",left:"71%",top:"23%",display:"flex",flexDirection:"column",alignItems:"center" }}>
          <div style={{ width:30,height:30,borderRadius:"50%",background:"linear-gradient(135deg,#34d399,#059669)",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 16px rgba(52,211,153,.5)" }}><MapPin size={13} color="#fff"/></div>
          <div style={{ width:1,height:12,background:"#34d399" }}/><div style={{ width:6,height:6,borderRadius:"50%",background:"#34d399" }}/>
        </div>
      )}
      <div style={{ position:"absolute",left:phase==="navigating_to_dropoff"?"44%":"50%",top:phase==="navigating_to_dropoff"?"50%":"57%",transform:"translate(-50%,-50%)",transition:"all 2.5s ease" }}>
        <div style={{ position:"relative" }}>
          <div style={{ position:"absolute",inset:0,width:44,height:44,borderRadius:"50%",background:T.teal,animation:"ping 2s ease-in-out infinite",opacity:.15 }}/>
          <div style={{ position:"relative",width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"2.5px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 4px 20px ${T.tealGlow}` }}><Truck size={20} color={T.bg}/></div>
        </div>
      </div>
      <div style={{ position:"absolute",bottom:10,right:14,color:"rgba(255,255,255,.18)",fontSize:9,fontFamily:"monospace",letterSpacing:".15em" }}>MYRA NAV 2.0</div>
      <style>{`@keyframes ping{0%,100%{transform:scale(1);opacity:.15}50%{transform:scale(2.2);opacity:0}}`}</style>
    </div>
  );
}

function LoadCard({ load, onConfirm, onDeny }) {
  const [timer, setTimer] = useState(load.timer);
  const [vis, setVis] = useState(true);
  useEffect(()=>{ if(timer<=0)return; const id=setTimeout(()=>setTimer(p=>p-1),1000); return()=>clearTimeout(id); },[timer]);
  const pct=(timer/load.timer)*100;
  const tc=pct>55?T.teal:pct>25?T.amber:T.red;
  const dismiss=fn=>{ setVis(false); setTimeout(fn,300); };
  return (
    <div style={{ transition:"opacity .3s,transform .3s",opacity:vis?1:0,transform:vis?"scale(1)":"scale(.94)" }}>
      <GlassPanel style={{ border:`1px solid ${T.border}`,overflow:"hidden" }}>
        <div style={{ height:3,background:"rgba(255,255,255,.06)" }}><div style={{ height:"100%",width:`${pct}%`,background:tc,transition:"width 1s linear,background .5s" }}/></div>
        <div style={{ padding:"14px 16px 16px" }}>
          <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12 }}>
            <div><div style={{ color:T.textMuted,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",marginBottom:2 }}>Load ID</div><div style={{ color:T.textPrimary,fontWeight:700,fontSize:13 }}>{load.id}</div></div>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <Pill color={T.blue}>{load.equipmentType}</Pill>
              <div style={{ background:`${tc}1a`,border:`1px solid ${tc}44`,borderRadius:8,padding:"3px 8px",color:tc,fontSize:12,fontWeight:800,fontFamily:"monospace",minWidth:40,textAlign:"center" }}>{timer}s</div>
            </div>
          </div>
          <div style={{ display:"flex",gap:12,marginBottom:12 }}>
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",paddingTop:4,gap:4 }}>
              <div style={{ width:8,height:8,borderRadius:"50%",background:T.blue,boxShadow:`0 0 8px ${T.blue}` }}/>
              <div style={{ width:1.5,height:28,background:`linear-gradient(to bottom,${T.blue},${T.teal})`,opacity:.5 }}/>
              <div style={{ width:8,height:8,borderRadius:"50%",background:T.teal,boxShadow:`0 0 8px ${T.teal}` }}/>
            </div>
            <div style={{ flex:1,display:"flex",flexDirection:"column",justifyContent:"space-between" }}>
              <div><div style={{ color:T.textMuted,fontSize:9,textTransform:"uppercase",letterSpacing:".1em" }}>Pick-up · {fmt(load.pickupWindowStart)}</div><div style={{ color:T.textPrimary,fontSize:12,fontWeight:600,marginTop:1 }}>{load.pickupLocation}</div></div>
              <div style={{ marginTop:8 }}><div style={{ color:T.textMuted,fontSize:9,textTransform:"uppercase",letterSpacing:".1em" }}>Drop-off</div><div style={{ color:T.textPrimary,fontSize:12,fontWeight:600,marginTop:1 }}>{load.dropoffLocation}</div></div>
            </div>
          </div>
          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14 }}>
            {[{l:"Rate",v:`$${load.freightRate}`,a:T.teal},{l:"Distance",v:load.distance},{l:"Weight",v:load.weight}].map(({l,v,a})=>(
              <div key={l} style={{ background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.07)",borderRadius:12,padding:"8px 6px",textAlign:"center" }}>
                <div style={{ color:T.textMuted,fontSize:8,textTransform:"uppercase",letterSpacing:".1em",marginBottom:3 }}>{l}</div>
                <div style={{ color:a||T.textPrimary,fontSize:11,fontWeight:700 }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <button onClick={()=>dismiss(()=>onDeny(load.id))} style={{ flex:1,padding:"11px 0",borderRadius:13,background:T.redDim,border:`1px solid ${T.red}33`,color:T.red,fontWeight:700,fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",gap:6,cursor:"pointer" }}><XCircle size={14}/>Decline</button>
            <button onClick={()=>dismiss(()=>onConfirm(load))} style={{ flex:2,padding:"11px 0",borderRadius:13,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",gap:6,cursor:"pointer",boxShadow:`0 4px 18px ${T.tealGlow}` }}><CheckCircle size={14}/>Accept Load</button>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}

function TurnPanel({ step, onNext, onPrev }) {
  const cur = TURNS[step]||TURNS[0];
  return (
    <div style={{ background:`${T.teal}08`,border:`1px solid ${T.teal}20`,borderRadius:16,padding:"12px 14px" }}>
      <div style={{ display:"flex",alignItems:"center",gap:12 }}>
        <div style={{ width:40,height:40,borderRadius:12,flexShrink:0,background:T.tealDim,display:"flex",alignItems:"center",justifyContent:"center" }}><TurnIcon type={cur.icon} size={20}/></div>
        <div style={{ flex:1,minWidth:0 }}>
          <div style={{ color:T.textPrimary,fontSize:13,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{cur.instruction}</div>
          <div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>{cur.distance} · {cur.duration}</div>
        </div>
        <div style={{ display:"flex",gap:6 }}>
          {step>0&&<button onClick={onPrev} style={{ width:28,height:28,borderRadius:8,background:"rgba(255,255,255,.06)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><ChevronLeft size={14} color={T.textMuted}/></button>}
          {step<TURNS.length-1&&<button onClick={onNext} style={{ width:28,height:28,borderRadius:8,background:T.tealDim,border:`1px solid ${T.teal}33`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><ChevronRight size={14} color={T.teal}/></button>}
        </div>
      </div>
      <div style={{ display:"flex",gap:4,marginTop:10 }}>
        {TURNS.map((_,i)=><div key={i} style={{ flex:1,height:3,borderRadius:3,background:i<=step?T.teal:"rgba(255,255,255,.1)",transition:"background .3s" }}/>)}
      </div>
    </div>
  );
}

function NavPanel({ phase, load, isPaused, onPauseToggle, onAction, step, onNext, onPrev }) {
  const cfgs = {
    navigating_to_pickup:  {dot:T.blue,  label:"Navigating to Pickup",   sub:load?.pickupAddress,  btn:"Arrived at Pickup",              btnIcon:<Package size={15}/>,    bg:`linear-gradient(135deg,#3b82f6,#2563eb)`},
    at_pickup:             {dot:T.green, label:"At Pickup Location",     sub:"Confirm load collected",btn:"Load Collected — Start Delivery",btnIcon:<Truck size={15}/>,      bg:`linear-gradient(135deg,${T.teal},#00b4a0)`},
    navigating_to_dropoff: {dot:T.teal,  label:"Navigating to Drop-off", sub:load?.dropoffAddress, btn:"Arrived at Drop-off",            btnIcon:<MapPin size={15}/>,     bg:`linear-gradient(135deg,#10b981,#059669)`},
    at_dropoff:            {dot:T.purple,label:"At Delivery Location",   sub:"Upload BOL & confirm",btn:"Confirm Delivery Complete",      btnIcon:<CheckCircle size={15}/>, bg:`linear-gradient(135deg,${T.purple},#7c3aed)`},
  };
  const c=cfgs[phase]; if(!c)return null;
  const showN=phase==="navigating_to_pickup"||phase==="navigating_to_dropoff";
  return (
    <div style={{ position:"absolute",bottom:0,left:0,right:0,background:"linear-gradient(180deg,rgba(6,14,26,.97),rgba(7,15,26,.99))",backdropFilter:"blur(32px)",borderTop:`1px solid ${T.borderMuted}`,borderRadius:"26px 26px 0 0",boxShadow:"0 -16px 60px rgba(0,0,0,.6)",paddingBottom:14 }}>
      <div style={{ display:"flex",justifyContent:"center",padding:"12px 0 8px" }}><div style={{ width:36,height:4,borderRadius:4,background:"rgba(255,255,255,.18)" }}/></div>
      <div style={{ padding:"0 18px" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
          <div>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <div style={{ width:8,height:8,borderRadius:"50%",background:c.dot,boxShadow:`0 0 8px ${c.dot}`,animation:"pulse 2s infinite" }}/>
              <span style={{ color:T.textPrimary,fontWeight:700,fontSize:14 }}>{c.label}</span>
            </div>
            <div style={{ color:T.textMuted,fontSize:11,marginTop:3,marginLeft:16,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{c.sub}</div>
          </div>
          {showN&&<button onClick={onPauseToggle} style={{ display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:11,cursor:"pointer",fontWeight:700,fontSize:11,background:isPaused?T.tealDim:`${T.amber}18`,border:`1px solid ${isPaused?T.teal+"44":T.amber+"44"}`,color:isPaused?T.teal:T.amber }}>{isPaused?<PlayCircle size={13}/>:<PauseCircle size={13}/>}{isPaused?"Resume":"Pause"}</button>}
        </div>
        {showN&&!isPaused&&<div style={{ marginBottom:14 }}><TurnPanel step={step} onNext={onNext} onPrev={onPrev}/></div>}
        {isPaused&&<div style={{ background:`${T.amber}0f`,border:`1px solid ${T.amber}33`,borderRadius:14,padding:"12px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10 }}><PauseCircle size={20} color={T.amber}/><div><div style={{ color:T.amber,fontWeight:700,fontSize:13 }}>Navigation Paused</div><div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>Tap Resume to continue</div></div></div>}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14 }}>
          {[{icon:<DollarSign size={11}/>,val:`$${load?.freightRate}`},{icon:<Navigation size={11}/>,val:load?.distance},{icon:<Clock size={11}/>,val:"~45 min"}].map(({icon,val},i)=>(
            <div key={i} style={{ borderRadius:12,padding:"8px 10px",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.07)",display:"flex",alignItems:"center",gap:6 }}><span style={{ color:T.textMuted }}>{icon}</span><span style={{ color:T.textPrimary,fontSize:11,fontWeight:700 }}>{val}</span></div>
          ))}
        </div>
        <button onClick={()=>onAction(phase)} style={{ width:"100%",padding:"16px 0",background:c.bg,border:"none",borderRadius:18,color:"#fff",fontWeight:800,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",gap:8,cursor:"pointer",boxShadow:"0 6px 28px rgba(0,0,0,.35)",letterSpacing:".02em",marginBottom:6 }}>{c.btnIcon}{c.btn}</button>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </div>
  );
}

function BOLScreen({ load, onComplete, onSkip }) {
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const go=()=>{ setUploading(true); setTimeout(()=>{ setUploading(false); setDone(true); },1800); };
  return (
    <div style={{ position:"absolute",inset:0,background:"linear-gradient(160deg,#061220,#0a1f30)",display:"flex",flexDirection:"column",padding:"60px 24px 40px",alignItems:"center",justifyContent:"center" }}>
      <div style={{ width:72,height:72,borderRadius:20,background:T.purpleDim,border:`1px solid ${T.purple}44`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:20 }}><FileText size={36} color={T.purple}/></div>
      <h2 style={{ color:T.textPrimary,fontSize:22,fontWeight:800,marginBottom:8,textAlign:"center" }}>Upload Bill of Lading</h2>
      <p style={{ color:T.textSecondary,fontSize:13,textAlign:"center",lineHeight:1.6,marginBottom:32 }}>Upload signed BOL for <strong style={{ color:T.textPrimary }}>{load?.id}</strong> before confirming.</p>
      {!done?(
        <>
          <button onClick={go} disabled={uploading} style={{ width:"100%",padding:"52px 0",borderRadius:20,marginBottom:14,background:"rgba(255,255,255,.04)",border:`2px dashed ${T.purple}55`,color:T.purple,fontWeight:700,fontSize:14,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,cursor:"pointer" }}>
            {uploading?<><Loader2 size={28} color={T.purple} style={{ animation:"spin 1s linear infinite" }}/><span>Uploading...</span></>:<><Upload size={28}/><span>Tap to Upload BOL</span><span style={{ fontSize:11,color:T.textMuted,fontWeight:400 }}>PDF, JPG, PNG supported</span></>}
          </button>
          <button onClick={onSkip} style={{ background:"none",border:"none",color:T.textMuted,fontSize:12,cursor:"pointer",textDecoration:"underline" }}>Skip for now</button>
        </>
      ):(
        <div style={{ width:"100%" }}>
          <div style={{ background:T.greenDim,border:`1px solid ${T.green}44`,borderRadius:14,padding:"16px 20px",display:"flex",alignItems:"center",gap:12,marginBottom:20 }}><CheckCircle size={22} color={T.green}/><div><div style={{ color:T.green,fontWeight:700,fontSize:13 }}>BOL Uploaded</div><div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>Document submitted</div></div></div>
          <button onClick={onComplete} style={{ width:"100%",padding:"16px 0",borderRadius:18,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:14,cursor:"pointer",boxShadow:`0 6px 24px ${T.tealGlow}` }}>Confirm Delivery Complete</button>
        </div>
      )}
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function CompleteScreen({ load, onReset }) {
  return (
    <div style={{ position:"absolute",inset:0,background:"linear-gradient(160deg,#061a0e,#0a2415,#081a20)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px" }}>
      <div style={{ position:"relative",marginBottom:24 }}>
        <div style={{ position:"absolute",inset:0,background:T.green,borderRadius:"50%",opacity:.15,animation:"ping 2s infinite" }}/>
        <div style={{ width:88,height:88,borderRadius:"50%",background:"linear-gradient(135deg,#34d399,#059669)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 40px rgba(52,211,153,.35)" }}><CheckCircle size={44} color="#fff"/></div>
      </div>
      <h2 style={{ color:T.textPrimary,fontSize:24,fontWeight:800,marginBottom:6 }}>Delivery Complete!</h2>
      <p style={{ color:T.textMuted,fontSize:13 }}>{load?.id} · {load?.commodity}</p>
      <div style={{ width:"100%",background:`${T.teal}08`,border:`1px solid ${T.teal}22`,borderRadius:20,padding:"18px 20px",margin:"24px 0" }}>
        <div style={{ color:T.textMuted,fontSize:9,textTransform:"uppercase",letterSpacing:".14em",textAlign:"center",marginBottom:14 }}>Trip Summary</div>
        {[{l:"Load",v:load?.id},{l:"Commodity",v:load?.commodity},{l:"Pick-up",v:load?.pickupLocation},{l:"Drop-off",v:load?.dropoffLocation},{l:"Distance",v:load?.distance},{l:"Earnings",v:`$${load?.freightRate}`,a:T.teal,big:true}].map(({l,v,a,big})=>(
          <div key={l} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10 }}><span style={{ color:T.textMuted,fontSize:12 }}>{l}</span><span style={{ color:a||T.textPrimary,fontSize:big?16:12,fontWeight:big?800:600 }}>{v}</span></div>
        ))}
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,width:"100%",marginBottom:14 }}>
        {[{icon:<Star size={15}/>,l:"Rate"},{icon:<FileText size={15}/>,l:"BOL"},{icon:<Phone size={15}/>,l:"Support"}].map(({icon,l})=>(
          <button key={l} style={{ padding:"12px 0",borderRadius:14,background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.08)",color:T.textSecondary,fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6 }}>{icon}{l}</button>
        ))}
      </div>
      <button onClick={onReset} style={{ width:"100%",padding:"16px 0",borderRadius:18,background:`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:14,cursor:"pointer",boxShadow:`0 6px 24px ${T.tealGlow}`,display:"flex",alignItems:"center",justifyContent:"center",gap:8 }}><RotateCcw size={16}/>Find Next Load</button>
      <style>{`@keyframes ping{0%,100%{transform:scale(1);opacity:.15}50%{transform:scale(2.4);opacity:0}}`}</style>
    </div>
  );
}

function HomeTab() {
  const [phase, setPhase] = useState("idle");
  const [loads, setLoads] = useState(LOADS);
  const [activeLoad, setActiveLoad] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [step, setStep] = useState(0);
  const [finding, setFinding] = useState(false);

  const isNav = ["navigating_to_pickup","at_pickup","navigating_to_dropoff","at_dropoff"].includes(phase);
  const isFullscreen = ["bol_upload","complete"].includes(phase);

  const handleConfirm = load => { setActiveLoad(load); setStep(0); setPhase("navigating_to_pickup"); };
  const handleDeny    = id  => { const n=loads.filter(l=>l.id!==id); setLoads(n); if(!n.length)setPhase("idle"); };
  const handleAction  = p  => { const m={navigating_to_pickup:"at_pickup",at_pickup:"navigating_to_dropoff",navigating_to_dropoff:"at_dropoff",at_dropoff:"bol_upload"}; setPhase(m[p]||"idle"); setIsPaused(false); setStep(0); };
  const handleReset   = () => { setPhase("idle"); setActiveLoad(null); setIsPaused(false); setStep(0); setLoads(LOADS); };
  const findLoad      = () => { setFinding(true); setTimeout(()=>{ setFinding(false); setPhase("selecting"); },1400); };

  if(isFullscreen) {
    if(phase==="bol_upload") return <BOLScreen load={activeLoad} onComplete={()=>setPhase("complete")} onSkip={()=>setPhase("complete")}/>;
    return <CompleteScreen load={activeLoad} onReset={handleReset}/>;
  }

  return (
    <div style={{ position:"absolute",inset:0 }}>
      <MapBG phase={phase} load={activeLoad}/>

      {/* Selecting */}
      {phase==="selecting"&&(
        <>
          <div style={{ position:"absolute",top:48,left:12,right:12,zIndex:20,display:"flex",alignItems:"center",gap:10 }}>
            <button onClick={()=>setPhase("idle")} style={{ width:38,height:38,borderRadius:12,background:T.surface,border:`1px solid ${T.borderMuted}`,backdropFilter:"blur(20px)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><ChevronLeft size={17} color={T.textPrimary}/></button>
            <GlassPanel style={{ flex:1,padding:"9px 14px",display:"flex",alignItems:"center",gap:8 }}><MapPin size={13} color={T.teal}/><span style={{ color:T.textPrimary,fontSize:12,fontWeight:600 }}>Durham Region · {loads.length} loads nearby</span></GlassPanel>
          </div>
          <div style={{ position:"absolute",bottom:0,left:0,right:0,maxHeight:"74%",overflowY:"auto",padding:"8px 14px 16px",scrollbarWidth:"none" }}>
            <div style={{ display:"flex",justifyContent:"center",padding:"12px 0 8px" }}><div style={{ width:36,height:4,borderRadius:4,background:"rgba(255,255,255,.18)" }}/></div>
            <div style={{ textAlign:"center",color:T.textMuted,fontSize:10,textTransform:"uppercase",letterSpacing:".12em",marginBottom:12,fontWeight:600 }}>Available Loads — Accept within timer</div>
            <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
              {loads.map(l=><LoadCard key={l.id} load={l} onConfirm={handleConfirm} onDeny={handleDeny}/>)}
            </div>
          </div>
        </>
      )}

      {/* Active navigation */}
      {isNav&&(
        <>
          <div style={{ position:"absolute",top:48,left:12,right:12,zIndex:20 }}>
            <GlassPanel style={{ padding:"10px 14px",display:"flex",alignItems:"center",gap:10,border:`1px solid ${T.borderMuted}` }}>
              <div style={{ width:32,height:32,borderRadius:10,background:T.tealDim,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}><Truck size={15} color={T.teal}/></div>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ color:T.textPrimary,fontSize:12,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{activeLoad?.id} · {activeLoad?.commodity}</div>
                <div style={{ color:T.textMuted,fontSize:10 }}>{(phase==="navigating_to_pickup"||phase==="at_pickup")?activeLoad?.pickupLocation:activeLoad?.dropoffLocation}</div>
              </div>
              <div style={{ display:"flex",gap:6 }}>
                <button style={{ width:30,height:30,borderRadius:9,background:T.blueDim,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><Phone size={13} color={T.blue}/></button>
                <button style={{ width:30,height:30,borderRadius:9,background:T.tealDim,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}><MessageSquare size={13} color={T.teal}/></button>
              </div>
            </GlassPanel>
          </div>
          <NavPanel phase={phase} load={activeLoad} isPaused={isPaused} onPauseToggle={()=>setIsPaused(p=>!p)} onAction={handleAction} step={step} onNext={()=>setStep(p=>Math.min(p+1,TURNS.length-1))} onPrev={()=>setStep(p=>Math.max(p-1,0))}/>
        </>
      )}

      {/* Idle */}
      {phase==="idle"&&(
        <div style={{ position:"absolute",bottom:0,left:0,right:0,background:"linear-gradient(180deg,rgba(6,14,26,.97),rgba(7,15,26,.99))",backdropFilter:"blur(32px)",borderTop:`1px solid ${T.borderMuted}`,borderRadius:"28px 28px 0 0",boxShadow:"0 -16px 60px rgba(0,0,0,.6)",paddingBottom:16 }}>
          <div style={{ display:"flex",justifyContent:"center",padding:"12px 0 8px" }}><div style={{ width:36,height:4,borderRadius:4,background:"rgba(255,255,255,.18)" }}/></div>
          <div style={{ padding:"4px 20px 0" }}>
            <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:16 }}>
              <div style={{ width:48,height:48,borderRadius:16,background:"linear-gradient(135deg,#1a3050,#0d1b2a)",border:`1px solid ${T.borderMuted}`,display:"flex",alignItems:"center",justifyContent:"center" }}><Truck size={22} color={T.teal}/></div>
              <div style={{ flex:1 }}><div style={{ color:T.textPrimary,fontWeight:800,fontSize:15 }}>Marcus Williams</div><div style={{ color:T.textMuted,fontSize:11,marginTop:2 }}>Kenworth T680 · ON-482-JHK</div></div>
              <div style={{ textAlign:"right" }}><div style={{ color:T.teal,fontWeight:800,fontSize:18 }}>$1,240</div><div style={{ color:T.textMuted,fontSize:10 }}>Today</div></div>
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:16 }}>
              {[{l:"Loads",v:"7",icon:<Package size={12} color={T.blue}/>},{l:"Km",v:"412",icon:<Navigation size={12} color={T.teal}/>},{l:"Rating",v:"4.9★",icon:<Star size={12} color={T.amber}/>},{l:isOnline?"Online":"Offline",v:"",toggle:true,icon:isOnline?<Wifi size={12} color={T.teal}/>:<WifiOff size={12} color={T.red}/>}].map(({l,v,icon,toggle})=>(
                <div key={l} onClick={toggle?()=>setIsOnline(p=>!p):undefined} style={{ borderRadius:14,padding:"10px 6px",textAlign:"center",background:toggle?(isOnline?T.tealDim:T.redDim):"rgba(255,255,255,.04)",border:`1px solid ${toggle?(isOnline?T.teal+"44":T.red+"44"):"rgba(255,255,255,.07)"}`,cursor:toggle?"pointer":"default" }}>
                  <div style={{ display:"flex",justifyContent:"center",marginBottom:4 }}>{icon}</div>
                  {v&&<div style={{ color:T.textPrimary,fontWeight:700,fontSize:13 }}>{v}</div>}
                  <div style={{ color:toggle?(isOnline?T.teal:T.red):T.textMuted,fontSize:9,textTransform:"uppercase",letterSpacing:".08em",marginTop:v?2:0 }}>{l}</div>
                </div>
              ))}
            </div>
            <button onClick={findLoad} disabled={finding} style={{ width:"100%",padding:"17px 0",borderRadius:20,background:finding?"rgba(0,229,195,.3)":`linear-gradient(135deg,${T.teal},#00b4a0)`,border:"none",color:T.bg,fontWeight:800,fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",gap:9,cursor:finding?"default":"pointer",boxShadow:`0 8px 32px ${T.tealGlow}` }}>
              {finding?<><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/>Finding Loads...</>:<><Navigation size={18}/>Find a Load</>}
            </button>
          </div>
          <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  ROOT
// ══════════════════════════════════════════
export default function MyraDriverApp() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState("home");

  const shell = {
    width:390, height:844, margin:"0 auto",
    position:"relative", overflow:"hidden",
    background:T.bg, borderRadius:46,
    boxShadow:"0 48px 120px rgba(0,0,0,.85), inset 0 0 0 1.5px rgba(255,255,255,.09)",
    fontFamily:"-apple-system,'SF Pro Display',BlinkMacSystemFont,sans-serif",
  };

  if(!loggedIn) return <div style={shell}><LoginScreen onLogin={()=>setLoggedIn(true)}/></div>;

  return (
    <div style={shell}>
      {/* Status bar */}
      <div style={{ position:"absolute",top:0,left:0,right:0,zIndex:60,height:44,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 22px",background:`linear-gradient(180deg,${T.bg} 80%,transparent)` }}>
        <span style={{ color:T.textPrimary,fontSize:13,fontWeight:700 }}>9:41</span>
        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
          <Bell size={15} color={T.textMuted}/>
          <Wifi size={13} color={T.teal}/>
        </div>
      </div>

      {/* Tab pages */}
      <div style={{ position:"absolute",inset:0 }}>
        {activeTab==="home"     && <HomeTab/>}
        {activeTab==="earnings" && <EarningsTab/>}
        {activeTab==="docs"     && <DocsTab/>}
        {activeTab==="settings" && <SettingsTab onLogout={()=>setLoggedIn(false)}/>}
      </div>

      {/* Bottom nav — hidden during full-screen nav phases on home */}
      <BottomNav active={activeTab} onChange={setActiveTab}/>
    </div>
  );
}
