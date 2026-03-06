"use client"

import { FileText, Download, CheckCircle2, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"

interface PODSectionProps {
  isDelivered: boolean
  podUrl?: string
  deliveredAt?: string
  signedBy?: string
}

export function PODSection({ isDelivered, podUrl, deliveredAt, signedBy }: PODSectionProps) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden font-sans">
      <div className="border-b border-border/60 px-5 py-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Proof of Delivery
        </h3>
      </div>

      {!isDelivered ? (
        <div className="p-5">
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-secondary/30 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary">
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Awaiting Delivery</p>
              <p className="mt-1.5 max-w-[260px] text-[11px] text-muted-foreground leading-relaxed">
                The POD document will appear here automatically once the driver confirms delivery.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <div className="flex items-start gap-4 rounded-lg bg-[var(--brand-success)]/5 ring-1 ring-[var(--brand-success)]/15 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-success)]/12">
              <FileText className="h-5 w-5 text-[var(--brand-success)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-foreground">Delivery Confirmed</p>
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-success)]/12 px-2 py-0.5 text-[10px] font-semibold text-[var(--brand-success)]">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  Signed
                </span>
              </div>
              {deliveredAt && (
                <p className="mt-1 text-[11px] text-muted-foreground">Delivered {deliveredAt}</p>
              )}
              {signedBy && (
                <p className="text-[11px] text-muted-foreground">
                  Signed by: <span className="text-foreground font-medium">{signedBy}</span>
                </p>
              )}
            </div>
            {podUrl && (
              <a href={podUrl} target="_blank" rel="noopener noreferrer">
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5 border-[var(--brand-success)]/20 text-[var(--brand-success)] hover:bg-[var(--brand-success)]/8"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
