"use client"

import { useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import { AppSidebar } from "@/components/app-sidebar"
import { Topbar } from "@/components/topbar"
import { CommandPalette } from "@/components/command-palette"
import { AIAssistant } from "@/components/ai-assistant"
import { WorkspaceProvider } from "@/lib/workspace-context"
import { TenantProvider } from "@/components/tenant-context"
import { TenantBrandingApplier } from "@/components/tenant-branding"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

// Routes that render without the app shell (sidebar, topbar, etc.)
const BARE_ROUTES = ["/login", "/invite"]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isBareRoute = BARE_ROUTES.some((r) => pathname.startsWith(r))

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  useEffect(() => {
    if (isBareRoute) return
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setCommandOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [isBareRoute])

  // Login and other bare routes render without the shell chrome
  if (isBareRoute) {
    return <>{children}</>
  }

  return (
    <TenantProvider>
      <TenantBrandingApplier />
      <WorkspaceProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <AppSidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar
            onOpenCommand={() => setCommandOpen(true)}
            onOpenAI={() => setAiOpen(true)}
          />
          <main className="flex-1 overflow-y-auto scrollbar-thin">
            {children}
          </main>
        </div>

        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <AIAssistant open={aiOpen} onClose={() => setAiOpen(false)} />

        {/* Floating AI Button */}
        {!aiOpen && (
          <Button
            onClick={() => setAiOpen(true)}
            size="icon"
            className="fixed bottom-4 right-4 z-40 h-10 w-10 rounded-full bg-accent text-accent-foreground shadow-lg hover:bg-accent/90 transition-all hover:scale-105"
          >
            <Sparkles className="h-4 w-4" />
            <span className="sr-only">Open AI Assistant</span>
          </Button>
        )}
      </div>
      </WorkspaceProvider>
    </TenantProvider>
  )
}
