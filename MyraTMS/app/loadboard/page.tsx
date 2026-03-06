"use client"

import { useState, useMemo, useCallback } from "react"
import { Search, Download, Radio, RefreshCw, ArrowUpDown, Plus, X, Wifi, WifiOff } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "sonner"

const formatCurrency = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

interface LoadboardLoad {
  id: string
  source: string
  origin: string
  origin_state: string
  destination: string
  destination_state: string
  equipment: string
  weight: string
  miles: number
  rate: number
  rate_per_mile: number
  pickup_date: string
  delivery_date: string
  shipper_name: string
  age: string
  commodity: string
}

interface SearchResponse {
  loads: LoadboardLoad[]
  total: number
  sources: string[]
  api_connected: boolean
  cached: boolean
  last_sync: string
}

const sourceColors: Record<string, string> = {
  DAT: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Truckstop: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "123Loadboard": "bg-amber-500/10 text-amber-400 border-amber-500/20",
}

type SortField = "rate" | "rate_per_mile" | "miles" | "pickup_date"

export default function LoadBoardPage() {
  const [search, setSearch] = useState("")
  const [originFilter, setOriginFilter] = useState("")
  const [destFilter, setDestFilter] = useState("")
  const [sourceFilter, setSourceFilter] = useState<string>("all")
  const [equipmentFilter, setEquipmentFilter] = useState<string>("all")
  const [sortField, setSortField] = useState<SortField>("pickup_date")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [importOpen, setImportOpen] = useState(false)
  const [selectedLoad, setSelectedLoad] = useState<LoadboardLoad | null>(null)
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  // Search state
  const [searchResults, setSearchResults] = useState<LoadboardLoad[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [apiConnected, setApiConnected] = useState(false)
  const [activeSources, setActiveSources] = useState<string[]>([])
  const [isCached, setIsCached] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)

  const handleSearch = useCallback(async () => {
    setSearching(true)
    try {
      const res = await fetch("/api/loadboard/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: originFilter || undefined,
          destination: destFilter || undefined,
          equipment: equipmentFilter !== "all" ? equipmentFilter : undefined,
        }),
      })
      const data: SearchResponse = await res.json()
      setSearchResults(data.loads || [])
      setApiConnected(data.api_connected)
      setActiveSources(data.sources || [])
      setIsCached(data.cached || false)
      setLastSync(data.last_sync || null)
      setHasSearched(true)
    } catch (err) {
      toast.error("Search failed", { description: "Could not connect to loadboard API" })
    } finally {
      setSearching(false)
    }
  }, [originFilter, destFilter, equipmentFilter])

  // Initial load -- search with no filters
  const handleInitialLoad = useCallback(() => {
    if (!hasSearched) handleSearch()
  }, [hasSearched, handleSearch])

  // Trigger initial load on first render
  useState(() => { handleInitialLoad() })

  const equipmentTypes = useMemo(() => [...new Set(searchResults.map((l) => l.equipment))], [searchResults])

  const filteredLoads = useMemo(() => {
    let results = [...searchResults]
    if (sourceFilter !== "all") results = results.filter((l) => l.source === sourceFilter)
    if (search) {
      const q = search.toLowerCase()
      results = results.filter(
        (l) =>
          l.origin.toLowerCase().includes(q) ||
          l.destination.toLowerCase().includes(q) ||
          l.commodity.toLowerCase().includes(q) ||
          l.shipper_name.toLowerCase().includes(q)
      )
    }
    results.sort((a, b) => {
      const aVal = a[sortField]
      const bVal = b[sortField]
      if (typeof aVal === "number" && typeof bVal === "number") return sortDir === "asc" ? aVal - bVal : bVal - aVal
      return sortDir === "asc" ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal))
    })
    return results
  }, [searchResults, search, sourceFilter, sortField, sortDir])

  const toggleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
        return prev
      }
      setSortDir("desc")
      return field
    })
  }, [])

  const handleImport = useCallback(async (load: LoadboardLoad) => {
    setImporting(true)
    try {
      const res = await fetch("/api/loadboard/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: load.origin,
          destination: load.destination,
          rate: load.rate,
          equipment: load.equipment,
          weight: load.weight,
          pickup_date: load.pickup_date,
          delivery_date: load.delivery_date,
          shipper_name: load.shipper_name,
          commodity: load.commodity,
          miles: load.miles,
          source_board: load.source,
          external_id: load.id,
        }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setImportedIds((prev) => new Set([...prev, load.id]))
        setImportOpen(false)
        setSelectedLoad(null)
        toast.success("Load imported to Myra", {
          description: `${load.origin} to ${load.destination} created as Booked. ID: ${data.load?.id}`,
        })
      } else {
        toast.error("Import failed", { description: data.error || "Unknown error" })
      }
    } catch {
      toast.error("Import failed", { description: "Network error" })
    } finally {
      setImporting(false)
    }
  }, [])

  const avgRate = searchResults.length > 0
    ? Math.round(searchResults.reduce((sum, l) => sum + l.rate_per_mile, 0) / searchResults.length * 100) / 100
    : 0

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Load Board</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Browse and import loads from external load boards</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2">
            {apiConnected ? (
              <>
                <Wifi className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-emerald-400">Live API</span>
                {isCached && <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400 ml-1">Cached</Badge>}
              </>
            ) : (
              <>
                <WifiOff className="h-3.5 w-3.5 text-amber-400" />
                <span>Sample data -- connect API keys for live feeds</span>
              </>
            )}
          </div>
          {activeSources.length > 0 && (
            <div className="flex items-center gap-1 mr-2">
              {activeSources.map((s) => (
                <Badge key={s} variant="outline" className={`text-[10px] border ${sourceColors[s] || "bg-neutral-500/10 text-neutral-400 border-neutral-500/20"}`}>{s}</Badge>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={handleSearch} disabled={searching}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${searching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => {
            const csv = [
              "Source,Origin,Destination,Equipment,Miles,Rate,Rate/Mi,Pickup,Commodity",
              ...filteredLoads.map((l) => `${l.source},${l.origin},${l.destination},${l.equipment},${l.miles},${l.rate},${l.rate_per_mile},${l.pickup_date},${l.commodity}`),
            ].join("\n")
            const blob = new Blob([csv], { type: "text/csv" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `loadboard-export-${new Date().toISOString().slice(0, 10)}.csv`
            a.click()
            toast.success("Exported to CSV")
          }}>
            <Download className="h-3.5 w-3.5 mr-1.5" />Export
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Available Loads</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">{searchResults.length}</p><p className="text-[11px] text-muted-foreground mt-0.5">{activeSources.length > 0 ? `From ${activeSources.join(", ")}` : "Search to load results"}</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Filtered Results</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">{filteredLoads.length}</p><p className="text-[11px] text-muted-foreground mt-0.5">Matching current filters</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Avg Rate/Mile</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">${avgRate}</p><p className="text-[11px] text-muted-foreground mt-0.5">All equipment types</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Imported</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">{importedIds.size}</p><p className="text-[11px] text-muted-foreground mt-0.5">{lastSync ? `Last sync ${new Date(lastSync).toLocaleTimeString()}` : "Not yet synced"}</p></CardContent></Card>
      </div>

      {/* Search Filters */}
      <Card className="bg-card border-border">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <Input placeholder="Origin city or state..." className="h-9 bg-secondary/30 border-border text-sm" value={originFilter} onChange={(e) => setOriginFilter(e.target.value)} />
            </div>
            <div className="flex-1 min-w-[180px]">
              <Input placeholder="Destination city or state..." className="h-9 bg-secondary/30 border-border text-sm" value={destFilter} onChange={(e) => setDestFilter(e.target.value)} />
            </div>
            <Select value={equipmentFilter} onValueChange={setEquipmentFilter}>
              <SelectTrigger className="w-[160px] h-9 bg-secondary/30 border-border text-xs"><SelectValue placeholder="Equipment" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Equipment</SelectItem>
                <SelectItem value="Dry Van 53'">Dry Van 53&apos;</SelectItem>
                <SelectItem value="Reefer 53'">Reefer 53&apos;</SelectItem>
                <SelectItem value="Flatbed 48'">Flatbed 48&apos;</SelectItem>
                <SelectItem value="Tanker">Tanker</SelectItem>
                <SelectItem value="Hopper">Hopper</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleSearch} disabled={searching} className="h-9">
              <Search className={`h-3.5 w-3.5 mr-1.5 ${searching ? "animate-spin" : ""}`} />
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>
          {/* Text filter across results */}
          <div className="flex items-center gap-3 mt-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Filter results by origin, destination, commodity, shipper..." className="pl-9 h-9 bg-secondary/30 border-border text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Tabs value={sourceFilter} onValueChange={setSourceFilter}>
              <TabsList className="h-9 bg-secondary/30">
                <TabsTrigger value="all" className="text-xs">All Sources</TabsTrigger>
                <TabsTrigger value="DAT" className="text-xs">DAT</TabsTrigger>
                <TabsTrigger value="Truckstop" className="text-xs">Truckstop</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {searching ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <RefreshCw className="h-8 w-8 mb-3 opacity-40 animate-spin" />
                <p className="text-sm">Searching load boards...</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-b-border hover:bg-transparent">
                    <TableHead className="text-[11px] font-medium text-muted-foreground w-[90px]">Source</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground">Origin</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground">Destination</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground">Equipment</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground cursor-pointer" onClick={() => toggleSort("miles")}><span className="flex items-center gap-1">Miles<ArrowUpDown className="h-3 w-3" /></span></TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground cursor-pointer text-right" onClick={() => toggleSort("rate")}><span className="flex items-center gap-1 justify-end">Rate<ArrowUpDown className="h-3 w-3" /></span></TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground cursor-pointer text-right" onClick={() => toggleSort("rate_per_mile")}><span className="flex items-center gap-1 justify-end">$/Mile<ArrowUpDown className="h-3 w-3" /></span></TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground cursor-pointer" onClick={() => toggleSort("pickup_date")}><span className="flex items-center gap-1">Pickup<ArrowUpDown className="h-3 w-3" /></span></TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground">Posted</TableHead>
                    <TableHead className="text-[11px] font-medium text-muted-foreground text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLoads.map((load) => (
                    <TableRow key={load.id} className="hover:bg-secondary/30 transition-colors border-b-border">
                      <TableCell><Badge variant="outline" className={`text-[10px] font-medium border ${sourceColors[load.source] || "bg-neutral-500/10 text-neutral-400 border-neutral-500/20"}`}>{load.source}</Badge></TableCell>
                      <TableCell>
                        <div>
                          <p className="text-xs font-medium text-foreground">{load.origin}</p>
                          <p className="text-[10px] text-muted-foreground">{load.commodity}</p>
                        </div>
                      </TableCell>
                      <TableCell><p className="text-xs text-foreground">{load.destination}</p></TableCell>
                      <TableCell><p className="text-xs text-muted-foreground">{load.equipment}</p></TableCell>
                      <TableCell><p className="text-xs font-mono text-foreground">{load.miles.toLocaleString()}</p></TableCell>
                      <TableCell className="text-right"><p className="text-xs font-mono font-medium text-foreground">{formatCurrency(load.rate)}</p></TableCell>
                      <TableCell className="text-right"><p className="text-xs font-mono text-muted-foreground">${load.rate_per_mile.toFixed(2)}</p></TableCell>
                      <TableCell><p className="text-xs text-muted-foreground">{new Date(load.pickup_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p></TableCell>
                      <TableCell><span className="text-[10px] text-muted-foreground">{load.age}</span></TableCell>
                      <TableCell className="text-right">
                        {importedIds.has(load.id) ? (
                          <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">Imported</Badge>
                        ) : (
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setSelectedLoad(load); setImportOpen(true) }}><Plus className="h-3 w-3 mr-1" />Import</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          {!searching && filteredLoads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Radio className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm">{hasSearched ? "No loads match your filters" : "Search to find available loads"}</p>
              <p className="text-xs mt-1">{hasSearched ? "Try adjusting your search criteria" : "Enter origin, destination, or equipment type"}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">Import Load to Myra</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">This will create a new load in Booked status in the database.</DialogDescription>
          </DialogHeader>
          {selectedLoad && (
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Origin</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.origin}</p>
                </div>
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Destination</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.destination}</p>
                </div>
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Rate</p>
                  <p className="text-sm font-medium font-mono text-foreground mt-0.5">{formatCurrency(selectedLoad.rate)}</p>
                </div>
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Equipment</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.equipment}</p>
                </div>
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Miles</p>
                  <p className="text-sm font-medium font-mono text-foreground mt-0.5">{selectedLoad.miles.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-md bg-secondary/30">
                  <p className="text-[11px] text-muted-foreground">Pickup</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{new Date(selectedLoad.pickup_date).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="p-3 rounded-md bg-secondary/30 flex items-center justify-between">
                <div>
                  <p className="text-[11px] text-muted-foreground">Source</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.source}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Shipper</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.shipper_name}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Commodity</p>
                  <p className="text-sm font-medium text-foreground mt-0.5">{selectedLoad.commodity}</p>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={importing} onClick={() => selectedLoad && handleImport(selectedLoad)}>
              {importing ? "Importing..." : "Import as Booked"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
