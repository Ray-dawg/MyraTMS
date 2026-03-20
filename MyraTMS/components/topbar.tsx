"use client"

import { Search, Bell, Sparkles, Command, X, CheckCheck, AlertTriangle, Info, CheckCircle, XCircle } from "lucide-react"
import { AlertCenter } from "@/components/alert-center"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"

function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const iconMap = {
  info: Info,
  warning: AlertTriangle,
  success: CheckCircle,
  error: XCircle,
}

const colorMap = {
  info: "text-accent",
  warning: "text-warning",
  success: "text-success",
  error: "text-destructive",
}

export function Topbar({ onOpenCommand, onOpenAI }: { onOpenCommand: () => void; onOpenAI: () => void }) {
  const { notifications, unreadCount, markRead, markAllRead, dismissNotification } = useWorkspace()
  const router = useRouter()

  const displayNotifications = notifications.slice(0, 10)

  const handleNotificationClick = (n: { id: string; link?: string | null; read: boolean }) => {
    if (!n.read) markRead(n.id)
    if (n.link) router.push(n.link)
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background/80 backdrop-blur-sm px-6">
      {/* Search */}
      <button
        onClick={onOpenCommand}
        className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary transition-colors w-72"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left text-xs">Search loads, shippers, carriers...</span>
        <Kbd className="text-[10px]"><Command className="h-2.5 w-2.5" />K</Kbd>
      </button>

      {/* Right Actions */}
      <div className="flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-accent-foreground">
                  {unreadCount}
                </span>
              )}
              <span className="sr-only">Notifications</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-0" sideOffset={8}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
              {unreadCount > 0 && (
                <Button variant="ghost" size="sm" className="h-7 text-[11px] text-muted-foreground gap-1" onClick={markAllRead}>
                  <CheckCheck className="h-3 w-3" />
                  Mark all read
                </Button>
              )}
            </div>
            <ScrollArea className="max-h-[400px]">
              {displayNotifications.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-xs text-muted-foreground">No notifications</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {displayNotifications.map((n) => {
                    const Icon = iconMap[n.type as keyof typeof iconMap] || Info
                    const desc = n.description || ""
                    const truncatedDesc = desc.length > 80
                      ? desc.slice(0, 80) + "..."
                      : desc
                    return (
                      <div
                        key={n.id}
                        className={cn(
                          "flex gap-3 px-4 py-3 transition-colors cursor-pointer hover:bg-secondary/50",
                          !n.read && "bg-accent/5"
                        )}
                        onClick={() => handleNotificationClick(n)}
                      >
                        <div className="mt-0.5 shrink-0">
                          <Icon className={cn("h-4 w-4", colorMap[n.type as keyof typeof colorMap] || "text-accent")} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-xs text-foreground leading-relaxed", !n.read && "font-medium")}>
                              {n.title}
                            </p>
                            <button
                              onClick={(e) => { e.stopPropagation(); dismissNotification(n.id) }}
                              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{truncatedDesc}</p>
                          <p className="text-[10px] text-muted-foreground/60 mt-1">
                            {timeAgo(n.created_at)}
                          </p>
                        </div>
                        {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />}
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
            <div className="border-t border-border px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-[11px] text-muted-foreground"
                onClick={() => router.push("/notifications")}
              >
                View all notifications
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <AlertCenter />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onOpenAI}
        >
          <Sparkles className="h-4 w-4" />
          <span className="sr-only">AI Assistant</span>
        </Button>
      </div>
    </header>
  )
}
