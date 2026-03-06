"use client"

import Image from "next/image"
import { ThemeToggle } from "./theme-toggle"

interface TrackingHeaderProps {
  loadNumber: string
  shipper: string
  carrier: string
  lastUpdated: string
}

export function TrackingHeader({ loadNumber, carrier, lastUpdated }: TrackingHeaderProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl font-sans">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 lg:px-6">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <Image
            src="/myra-logo.png"
            alt="Myra AI"
            width={32}
            height={32}
            className="rounded-lg"
          />
          <div className="flex items-baseline gap-1">
            <span className="text-base font-semibold tracking-tight text-foreground">Myra</span>
            <span className="text-base font-semibold tracking-tight text-primary">AI</span>
          </div>
          <div className="hidden h-4 w-px bg-border sm:block" />
          <span className="hidden text-xs text-muted-foreground sm:block">Shipment Tracking</span>
        </div>

        {/* Desktop meta */}
        <div className="hidden items-center gap-5 md:flex">
          <div className="text-right">
            <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Load</p>
            <p className="font-mono text-xs font-semibold text-foreground">{loadNumber}</p>
          </div>
          <div className="h-6 w-px bg-border" />
          <div className="text-right">
            <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Carrier</p>
            <p className="text-xs font-medium text-foreground">{carrier}</p>
          </div>
          <div className="h-6 w-px bg-border" />
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-live-pulse" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <span className="text-xs text-muted-foreground">
              Updated <span className="text-foreground font-medium">{lastUpdated}</span>
            </span>
          </div>
          <div className="h-6 w-px bg-border" />
          <ThemeToggle />
        </div>

        {/* Mobile meta */}
        <div className="flex items-center gap-3 md:hidden">
          <ThemeToggle />
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-live-pulse" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          <span className="font-mono text-xs font-semibold text-foreground">{loadNumber}</span>
        </div>
      </div>
    </header>
  )
}
