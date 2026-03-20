"use client"

import { useState } from "react"
import { toast } from "sonner"
import { FileText, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface CreateInvoiceDialogProps {
  loadId: string
  loadRevenue?: number
  shipperId?: string
  shipperName?: string
  referenceNumber?: string
  carrierId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function CreateInvoiceDialog({
  loadId,
  loadRevenue = 0,
  shipperName = "",
  referenceNumber = "",
  open,
  onOpenChange,
  onSuccess,
}: CreateInvoiceDialogProps) {
  const today = new Date()
  const defaultDue = new Date(today)
  defaultDue.setDate(defaultDue.getDate() + 30)
  const fmt = (d: Date) => d.toISOString().split("T")[0]

  const [amount, setAmount] = useState(String(loadRevenue || ""))
  const [issueDate, setIssueDate] = useState(fmt(today))
  const [dueDate, setDueDate] = useState(fmt(defaultDue))
  const [paymentTerms, setPaymentTerms] = useState("net30")
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount < 0) {
      toast.error("Enter a valid amount")
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/loads/${loadId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: parsedAmount,
          dueDate,
          notes: notes.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Failed to create invoice")
      }
      toast.success("Invoice created successfully")
      onOpenChange(false)
      onSuccess?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create invoice")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Create Invoice
            {referenceNumber && (
              <span className="text-sm font-normal text-muted-foreground ml-1">
                — {referenceNumber}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {shipperName && (
            <div className="grid gap-1.5">
              <Label>Shipper</Label>
              <Input value={shipperName} disabled className="bg-muted/50" />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="inv-amount">Amount (USD) *</Label>
            <Input
              id="inv-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="inv-issue">Issue Date</Label>
              <Input
                id="inv-issue"
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-due">Due Date</Label>
              <Input
                id="inv-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Payment Terms</Label>
            <Select value={paymentTerms} onValueChange={setPaymentTerms}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="net15">Net 15</SelectItem>
                <SelectItem value="net30">Net 30</SelectItem>
                <SelectItem value="net45">Net 45</SelectItem>
                <SelectItem value="net60">Net 60</SelectItem>
                <SelectItem value="due_on_receipt">Due on Receipt</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="inv-notes">Notes (optional)</Label>
            <Textarea
              id="inv-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes for this invoice..."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
