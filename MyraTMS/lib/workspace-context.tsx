"use client"

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react"

export type WorkspaceView = "admin" | "operations"

export interface Notification {
  id: string
  title: string
  description: string
  type: "info" | "warning" | "success" | "error"
  read: boolean
  timestamp: string
  link?: string | null
}

export interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone: string
  role: "admin" | "ops" | "sales"
  avatarInitials: string
}

interface WorkspaceContextType {
  view: WorkspaceView
  setView: (view: WorkspaceView) => void
  notifications: Notification[]
  markRead: (id: string) => void
  markAllRead: () => void
  addNotification: (n: Omit<Notification, "id" | "read">) => void
  dismissNotification: (id: string) => void
  unreadCount: number
  profile: UserProfile
  updateProfile: (updates: Partial<UserProfile>) => void
  profileLoading: boolean
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null)

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

/**
 * Returns the full name of the current user from workspace context.
 * Must be called within a component wrapped by WorkspaceProvider.
 */
export function getCurrentUserName(): string {
  // This is a convenience wrapper -- components should use the hook directly.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { profile } = useWorkspace()
  return `${profile.firstName} ${profile.lastName}`
}

const fallbackProfile: UserProfile = {
  firstName: "User",
  lastName: "",
  email: "",
  phone: "",
  role: "admin",
  avatarInitials: "U",
}

function mapDbNotification(row: Record<string, unknown>): Notification {
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    description: String(row.description || row.body || row.message || ""),
    type: (row.type as Notification["type"]) || "info",
    read: Boolean(row.read),
    timestamp: String(row.created_at || row.timestamp || new Date().toISOString()),
    link: (row.link as string) || null,
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<WorkspaceView>("admin")
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [profile, setProfile] = useState<UserProfile>(fallbackProfile)
  const [profileLoading, setProfileLoading] = useState(true)

  // Fetch the real user profile on mount
  useEffect(() => {
    let cancelled = false

    async function fetchUser() {
      try {
        const res = await fetch("/api/auth/me")
        if (!res.ok) {
          return
        }
        const data = await res.json()
        if (cancelled) return

        const user = data.user
        if (user) {
          setProfile({
            firstName: user.firstName || "User",
            lastName: user.lastName || "",
            email: user.email || "",
            phone: user.phone || "",
            role: (user.role as UserProfile["role"]) || "admin",
            avatarInitials: `${(user.firstName || "U")[0]}${(user.lastName || "")[0] || ""}`.toUpperCase(),
          })
        }
      } catch {
        // Network error -- keep fallback defaults
      } finally {
        if (!cancelled) {
          setProfileLoading(false)
        }
      }
    }

    fetchUser()
    return () => { cancelled = true }
  }, [])

  // Fetch notifications from the database
  useEffect(() => {
    let cancelled = false

    async function fetchNotifications() {
      try {
        const res = await fetch("/api/notifications")
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        // Support both new { notifications, unreadCount } and legacy array format
        if (data.notifications && Array.isArray(data.notifications)) {
          setNotifications(data.notifications.map(mapDbNotification))
        } else if (Array.isArray(data)) {
          setNotifications(data.map(mapDbNotification))
        }
      } catch {
        // Keep empty array on error
      }
    }

    fetchNotifications()

    // Poll every 30 seconds for new notifications
    const interval = setInterval(fetchNotifications, 30000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Connect to SSE stream for real-time notification updates
  useEffect(() => {
    let es: EventSource | null = null

    try {
      es = new EventSource("/api/notifications/stream")

      es.addEventListener("notification", (event) => {
        try {
          const data = JSON.parse(event.data)
          const mapped: Notification = {
            id: data.id,
            title: data.title || "",
            description: data.body || "",
            type: data.type || "info",
            read: false,
            timestamp: data.createdAt || new Date().toISOString(),
          }
          setNotifications((prev) => {
            // Avoid duplicates
            if (prev.some((n) => n.id === mapped.id)) return prev
            return [mapped, ...prev]
          })
        } catch {
          // Ignore parse errors
        }
      })

      es.onerror = () => {
        // EventSource auto-reconnects, no action needed
      }
    } catch {
      // SSE not supported or failed to connect
    }

    return () => {
      es?.close()
    }
  }, [])

  const markRead = useCallback(async (id: string) => {
    // Optimistic update
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    // Persist to DB
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH" })
    } catch {
      // Revert on failure silently
    }
  }, [])

  const markAllRead = useCallback(async () => {
    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    // Persist to DB
    try {
      await fetch("/api/notifications/read-all", { method: "PATCH" })
    } catch {
      // Revert on failure silently
    }
  }, [])

  const addNotification = useCallback((n: Omit<Notification, "id" | "read">) => {
    // Add locally first for immediate feedback
    const localId = `n${Date.now()}`
    setNotifications((prev) => [
      { ...n, id: localId, read: false },
      ...prev,
    ])
    // We don't persist add here since notifications are typically
    // created by API routes / server-side processes
  }, [])

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const updateProfile = useCallback((updates: Partial<UserProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...updates }
      next.avatarInitials = `${next.firstName[0]}${next.lastName[0] || ""}`.toUpperCase()
      return next
    })
  }, [])

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <WorkspaceContext.Provider
      value={{
        view,
        setView,
        notifications,
        markRead,
        markAllRead,
        addNotification,
        dismissNotification,
        unreadCount,
        profile,
        updateProfile,
        profileLoading,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}
