"use client"

import { useState, useCallback, useRef } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Upload,
  Download,
  FileSpreadsheet,
  Users,
  Building2,
  Truck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RotateCcw,
  FileDown,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { toast } from "sonner"
import type { ImportType, ValidationResult, ValidatedRow, ImportResult } from "@/lib/import/types"

// ────────────────────────────────────────────────────────────────────
// Steps
// ────────────────────────────────────────────────────────────────────
type Step = "select" | "upload" | "review" | "importing" | "done"

const TYPE_CONFIG: Record<
  ImportType,
  { label: string; description: string; icon: typeof Users; color: string }
> = {
  carriers: {
    label: "Import Carriers",
    description: "Upload carrier companies with MC/DOT numbers, contacts, and insurance details",
    icon: Users,
    color: "text-blue-500",
  },
  shippers: {
    label: "Import Shippers",
    description: "Upload shipper companies with contacts, industry, and contract status",
    icon: Building2,
    color: "text-emerald-500",
  },
  loads: {
    label: "Import Loads",
    description: "Upload loads with origin/destination, dates, rates, and carrier/shipper assignments",
    icon: Truck,
    color: "text-amber-500",
  },
}

// Key fields to preview per type
const PREVIEW_FIELDS: Record<ImportType, string[]> = {
  carriers: ["company_name", "mc_number", "contact_name", "contact_phone"],
  shippers: ["company_name", "contact_name", "contact_email", "contact_phone"],
  loads: ["origin", "destination", "pickup_date", "delivery_date"],
}

export default function BulkImportPage() {
  const [step, setStep] = useState<Step>("select")
  const [importType, setImportType] = useState<ImportType | null>(null)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [validating, setValidating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Select type ────────────────────────────────────────────────

  const handleSelectType = (type: ImportType) => {
    setImportType(type)
    setStep("upload")
    setValidationResult(null)
    setSelectedRows(new Set())
    setImportResult(null)
  }

  // ── Template download ──────────────────────────────────────────

  const handleDownloadTemplate = async (type: ImportType) => {
    try {
      const res = await fetch(`/api/import/template/${type}`)
      if (!res.ok) throw new Error("Download failed")
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${type}_template.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Failed to download template")
    }
  }

  // ── File upload & validate ─────────────────────────────────────

  const handleFileUpload = useCallback(
    async (file: File) => {
      if (!importType) return

      if (!file.name.endsWith(".csv")) {
        toast.error("Please upload a CSV file")
        return
      }

      if (file.size > 5 * 1024 * 1024) {
        toast.error("File exceeds 5MB limit")
        return
      }

      setValidating(true)

      try {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("import_type", importType)

        const res = await fetch("/api/import/validate", {
          method: "POST",
          body: formData,
        })

        if (!res.ok) {
          const data = await res.json()
          toast.error(data.error || "Validation failed")
          if (data.details) {
            for (const d of data.details.slice(0, 3)) {
              toast.error(d)
            }
          }
          setValidating(false)
          return
        }

        const result: ValidationResult = await res.json()
        setValidationResult(result)

        // Auto-select all valid rows
        const validRowNumbers = new Set(
          result.rows.filter((r) => r.status === "valid").map((r) => r.row_number)
        )
        setSelectedRows(validRowNumbers)
        setStep("review")
      } catch {
        toast.error("Failed to validate CSV")
      } finally {
        setValidating(false)
      }
    },
    [importType]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFileUpload(file)
    },
    [handleFileUpload]
  )

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFileUpload(file)
      // Reset input so same file can be re-selected
      e.target.value = ""
    },
    [handleFileUpload]
  )

  // ── Row selection ──────────────────────────────────────────────

  const toggleRow = (rowNum: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowNum)) next.delete(rowNum)
      else next.add(rowNum)
      return next
    })
  }

  const selectAllValid = () => {
    if (!validationResult) return
    const validNums = validationResult.rows
      .filter((r) => r.status === "valid")
      .map((r) => r.row_number)
    setSelectedRows(new Set(validNums))
  }

  const deselectAll = () => setSelectedRows(new Set())

  // ── Execute import ─────────────────────────────────────────────

  const handleImport = async () => {
    if (!validationResult || !importType) return
    setShowConfirmDialog(false)
    setStep("importing")
    setImporting(true)
    setImportProgress(10)

    try {
      const rowsToImport = validationResult.rows
        .filter((r) => selectedRows.has(r.row_number) && r.status === "valid")
        .map((r) => ({ row_number: r.row_number, data: r.data }))

      setImportProgress(30)

      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          import_type: importType,
          rows: rowsToImport,
        }),
      })

      setImportProgress(80)

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Import failed")
      }

      const result: ImportResult = await res.json()
      setImportResult(result)
      setImportProgress(100)
      setStep("done")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed")
      setStep("review")
    } finally {
      setImporting(false)
    }
  }

  // ── Error report download ──────────────────────────────────────

  const downloadErrorReport = () => {
    if (!importResult || !validationResult) return

    const skippedNums = new Set(importResult.skipped_details.map((s) => s.row_number))
    const errorRows = validationResult.rows.filter(
      (r) => r.status !== "valid" || skippedNums.has(r.row_number)
    )

    const headers = Object.keys(errorRows[0]?.data || {})
    const csvLines = [
      [...headers, "error_reason"].join(","),
      ...errorRows.map((r) => {
        const reason =
          r.errors.join("; ") ||
          importResult.skipped_details.find((s) => s.row_number === r.row_number)?.reason ||
          ""
        return [
          ...headers.map((h) => `"${(r.data[h] || "").replace(/"/g, '""')}"`),
          `"${reason.replace(/"/g, '""')}"`,
        ].join(",")
      }),
    ]

    const blob = new Blob([csvLines.join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${importType}_errors.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Reset ──────────────────────────────────────────────────────

  const handleReset = () => {
    setStep("select")
    setImportType(null)
    setValidationResult(null)
    setSelectedRows(new Set())
    setImportResult(null)
    setImportProgress(0)
  }

  // ── Selected valid count ───────────────────────────────────────

  const selectedValidCount = validationResult
    ? validationResult.rows.filter(
        (r) => r.status === "valid" && selectedRows.has(r.row_number)
      ).length
    : 0

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/settings">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Bulk Import
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Upload CSV files to bulk-create carriers, shippers, or loads
          </p>
        </div>
      </div>

      {/* Step 1: Select Import Type */}
      {step === "select" && (
        <div className="grid gap-4 md:grid-cols-3">
          {(Object.entries(TYPE_CONFIG) as [ImportType, typeof TYPE_CONFIG.carriers][]).map(
            ([type, config]) => {
              const Icon = config.icon
              return (
                <Card
                  key={type}
                  className="border-border bg-card cursor-pointer transition-all hover:border-primary/50 hover:shadow-md"
                  onClick={() => handleSelectType(type)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${config.color}`} />
                      <CardTitle className="text-sm">{config.label}</CardTitle>
                    </div>
                    <CardDescription className="text-xs">
                      {config.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs flex-1"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownloadTemplate(type)
                      }}
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Template
                    </Button>
                    <Button
                      size="sm"
                      className="text-xs flex-1"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleSelectType(type)
                      }}
                    >
                      <Upload className="h-3 w-3 mr-1" />
                      Upload
                    </Button>
                  </CardContent>
                </Card>
              )
            }
          )}
        </div>
      )}

      {/* Step 2: Upload & Validate */}
      {step === "upload" && importType && (
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {(() => {
                  const Icon = TYPE_CONFIG[importType].icon
                  return <Icon className={`h-5 w-5 ${TYPE_CONFIG[importType].color}`} />
                })()}
                <CardTitle className="text-sm">{TYPE_CONFIG[importType].label}</CardTitle>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => handleDownloadTemplate(importType)}
                >
                  <Download className="h-3 w-3 mr-1" />
                  Download Template
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={handleReset}
                >
                  <ArrowLeft className="h-3 w-3 mr-1" />
                  Back
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {validating ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Validating CSV...</p>
              </div>
            ) : (
              <div
                className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground mb-1">
                  Drop your CSV file here
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  or click to browse (max 5MB, up to 5,000 rows)
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={onFileSelect}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Browse Files
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review Results */}
      {step === "review" && validationResult && importType && (
        <div className="space-y-4">
          {/* Summary bar */}
          <Card className="border-border bg-card">
            <CardContent className="py-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    <span className="text-sm font-medium">
                      {validationResult.valid_rows} valid
                    </span>
                  </div>
                  {validationResult.error_rows > 0 && (
                    <div className="flex items-center gap-1.5">
                      <XCircle className="h-4 w-4 text-destructive" />
                      <span className="text-sm font-medium">
                        {validationResult.error_rows} errors
                      </span>
                    </div>
                  )}
                  {validationResult.duplicate_rows > 0 && (
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <span className="text-sm font-medium">
                        {validationResult.duplicate_rows} duplicates
                      </span>
                    </div>
                  )}
                  <span className="text-xs text-muted-foreground">
                    out of {validationResult.total_rows} rows
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={handleReset}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Start Over
                  </Button>
                  <Button
                    size="sm"
                    className="text-xs"
                    onClick={() => setShowConfirmDialog(true)}
                    disabled={selectedValidCount === 0}
                  >
                    <Upload className="h-3 w-3 mr-1" />
                    Import {selectedValidCount} Records
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Selection controls */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={selectAllValid}
            >
              Select All Valid ({validationResult.valid_rows})
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={deselectAll}
            >
              Deselect All
            </Button>
          </div>

          {/* Results table */}
          <Card className="border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead className="text-xs w-12">#</TableHead>
                    <TableHead className="text-xs w-24">Status</TableHead>
                    {PREVIEW_FIELDS[importType].map((f) => (
                      <TableHead key={f} className="text-xs">
                        {f.replace(/_/g, " ")}
                      </TableHead>
                    ))}
                    <TableHead className="text-xs">Issues</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {validationResult.rows.map((row) => (
                    <TableRow
                      key={row.row_number}
                      className={
                        row.status === "error"
                          ? "bg-destructive/5"
                          : row.status === "duplicate"
                            ? "bg-amber-500/5"
                            : ""
                      }
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedRows.has(row.row_number)}
                          onCheckedChange={() => toggleRow(row.row_number)}
                          disabled={row.status !== "valid"}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.row_number}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      {PREVIEW_FIELDS[importType].map((f) => (
                        <TableCell key={f} className="text-xs max-w-[200px] truncate">
                          {row.data[f] || "-"}
                        </TableCell>
                      ))}
                      <TableCell className="text-xs">
                        {row.errors.length > 0 && (
                          <div className="space-y-0.5">
                            {row.errors.map((err, i) => (
                              <p key={i} className="text-destructive text-[11px]">
                                {err}
                              </p>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* Confirm dialog */}
          <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-sm">Confirm Import</DialogTitle>
                <DialogDescription className="text-xs">
                  You are about to create{" "}
                  <span className="font-semibold text-foreground">
                    {selectedValidCount} {importType}
                  </span>
                  . This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => setShowConfirmDialog(false)}
                >
                  Cancel
                </Button>
                <Button size="sm" className="text-xs" onClick={handleImport}>
                  Import {selectedValidCount} Records
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Step 4: Importing progress */}
      {step === "importing" && (
        <Card className="border-border bg-card">
          <CardContent className="py-12">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  Importing records...
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Please don&apos;t close this page
                </p>
              </div>
              <div className="w-64">
                <Progress value={importProgress} className="h-2" />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 5: Done */}
      {step === "done" && importResult && (
        <Card className="border-border bg-card">
          <CardContent className="py-12">
            <div className="flex flex-col items-center gap-4">
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <div className="text-center">
                <p className="text-lg font-semibold text-foreground">
                  Import Complete
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  Successfully created{" "}
                  <span className="font-medium text-foreground">
                    {importResult.created}
                  </span>{" "}
                  {importType}.
                  {importResult.skipped > 0 && (
                    <>
                      {" "}
                      <span className="text-amber-500">
                        {importResult.skipped} skipped
                      </span>
                      .
                    </>
                  )}
                </p>
              </div>

              {importResult.skipped > 0 && (
                <div className="w-full max-w-md">
                  <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      Skipped rows:
                    </p>
                    {importResult.skipped_details.slice(0, 5).map((s) => (
                      <p key={s.row_number} className="text-xs text-muted-foreground">
                        Row {s.row_number}: {s.reason}
                      </p>
                    ))}
                    {importResult.skipped_details.length > 5 && (
                      <p className="text-xs text-muted-foreground">
                        ...and {importResult.skipped_details.length - 5} more
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex gap-2 mt-2">
                {importResult.skipped > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={downloadErrorReport}
                  >
                    <FileDown className="h-3 w-3 mr-1" />
                    Download Error Report
                  </Button>
                )}
                <Button size="sm" className="text-xs" onClick={handleReset}>
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Import More
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Status badge component ───────────────────────────────────────

function StatusBadge({ status }: { status: ValidatedRow["status"] }) {
  if (status === "valid") {
    return (
      <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-500 bg-emerald-500/10">
        Valid
      </Badge>
    )
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="text-[10px] border-destructive/30 text-destructive bg-destructive/10">
        Error
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500 bg-amber-500/10">
      Duplicate
    </Badge>
  )
}
