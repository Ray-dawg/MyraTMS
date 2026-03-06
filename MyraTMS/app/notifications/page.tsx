"use client"

import { useState } from "react"
import { useWorkspace, type Notification } from "@/lib/workspace-context"
import { Button } from "@/components/ui/button"
import { CheckCheck, AlertTriangle, Info, CheckCircle, XCircle, Bell } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"

const iconMap: Record<string, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  success: CheckCircle,
  error: XCircle,
}

const colorMap: Record<string, string> = {
  info: "text-accent",
  warning: "text-warning",
  success: "text-success",
  error: "text-destructive",
}

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

export default function NotificationsPage() {
  const { notifications, unreadCount, markRead, markAllRead } = useWorkspace()
  const [filter, setFilter] = useState<"all" | "unread">("all")
  const router = useRouter()

  const filtered = filter === "unread"
    ? notifications.filter((n) => !n.read)
    : notifications

  const handleClick = (n: Notification) => {
    if (!n.read) markRead(n.id)
    if (n.link) router.push(n.link)
  }

  return (
    <div className="mx-auto max-w-3xl py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={markAllRead}>
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </Button>
        )}
      </div>

      <div className="flex gap-1 mb-4">
        <Button
          variant={filter === "all" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setFilter("all")}
        >
          All
        </Button>
        <Button
          variant={filter === "unread" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setFilter("unread")}
        >
          Unread {unreadCount > 0 && `(${unreadCount})`}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <Bell className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {filter === "unread" ? "No unread notifications" : "No notifications yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((n) => {
            const Icon = iconMap[n.type] || Info
            return (
              <div
                key={n.id}
                className={cn(
                  "flex gap-3 px-4 py-3 rounded-lg transition-colors cursor-pointer hover:bg-secondary/50",
                  !n.read && "bg-accent/5 border border-accent/10"
                )}
                onClick={() => handleClick(n)}
              >
                <div className="mt-0.5 shrink-0">
                  <Icon className={cn("h-4 w-4", colorMap[n.type] || "text-muted-foreground")} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className={cn("text-sm text-foreground", !n.read && "font-medium")}>
                      {n.title}
                    </p>
                    {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{n.description}</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">{timeAgo(n.timestamp)}</p>
                </div>
                {!n.read && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-[11px] text-muted-foreground h-7"
                    onClick={(e) => { e.stopPropagation(); markRead(n.id) }}
                  >
                    Mark read
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
