"use client"

import { Phone, Mail } from "lucide-react"
import Image from "next/image"

export function TrackingFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-card font-sans">
      <div className="mx-auto max-w-6xl px-4 py-6 lg:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
          <Image
            src="/myra-logo.png"
            alt="Myra AI"
            width={24}
            height={24}
            className="rounded-md"
          />
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-semibold text-foreground">Myra</span>
              <span className="text-sm font-semibold text-primary">AI</span>
            </div>
            <div className="h-3 w-px bg-border" />
            <span className="text-[11px] text-muted-foreground">Freight Brokerage</span>
          </div>

          {/* Contact */}
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-5">
            <a
              href="tel:+18005550100"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Phone className="h-3 w-3 shrink-0" />
              1-800-MYRA-AI
            </a>
            <a
              href="mailto:dispatch@myra-ai.com"
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Mail className="h-3 w-3 shrink-0" />
              dispatch@myra-ai.com
            </a>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] text-muted-foreground/50 leading-relaxed max-w-lg">
            This tracking page was sent by Myra AI on behalf of your freight broker. Location data refreshes every 15 minutes. For urgent inquiries, contact your broker directly.
          </p>
          <p className="text-[10px] text-muted-foreground/40">
            &copy; {new Date().getFullYear()} Myra AI, Inc.
          </p>
        </div>
      </div>
    </footer>
  )
}
