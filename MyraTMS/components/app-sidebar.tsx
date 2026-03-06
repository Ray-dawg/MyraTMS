"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import {
  LayoutDashboard,
  Truck,
  Building2,
  Users,
  FileText,
  DollarSign,
  Brain,
  Settings,
  Moon,
  Sun,
  ChevronsUpDown,
  ClipboardList,
  BarChart3,
  UserCircle,
  Check,
  Globe,
  ShieldCheck,
  Calculator,
  Map
} from "lucide-react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useWorkspace } from "@/lib/workspace-context"

const adminNavigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Load Board", href: "/loadboard", icon: Globe },
  { name: "Loads", href: "/loads", icon: Truck },
  { name: "Map", href: "/map", icon: Map },
  { name: "Quotes", href: "/quotes", icon: Calculator },
  { name: "Shippers", href: "/shippers", icon: Building2 },
  { name: "Carriers", href: "/carriers", icon: Users },
  { name: "Compliance", href: "/compliance", icon: ShieldCheck },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "Finance", href: "/finance", icon: DollarSign },
  { name: "Intelligence", href: "/intelligence", icon: Brain },
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Workflows", href: "/workflows", icon: ClipboardList },
  { name: "Profile", href: "/profile", icon: UserCircle },
  { name: "Settings", href: "/settings", icon: Settings },
]

const opsNavigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Load Board", href: "/loadboard", icon: Globe },
  { name: "Loads", href: "/loads", icon: Truck },
  { name: "Map", href: "/map", icon: Map },
  { name: "Quotes", href: "/quotes", icon: Calculator },
  { name: "Carriers", href: "/carriers", icon: Users },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "Workflows", href: "/workflows", icon: ClipboardList },
  { name: "Profile", href: "/profile", icon: UserCircle },
]

export function AppSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const { view, setView, profile } = useWorkspace()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const navigation = view === "admin" ? adminNavigation : opsNavigation

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          "flex h-screen flex-col border-r border-border bg-sidebar transition-all duration-200",
          collapsed ? "w-16" : "w-56"
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 px-4">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-sidebar-foreground hover:opacity-80 transition-opacity"
          >
            <Image src="/myra-logo-192.png" alt="Myra" width={28} height={28} className="rounded-md" />
            {!collapsed && (
              <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
                Myra
              </span>
            )}
          </button>
        </div>

        <Separator className="bg-sidebar-border" />

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 px-2 py-3 overflow-y-auto scrollbar-thin">
          {navigation.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href)

            const link = (
              <Link
                key={item.name}
                href={item.href}
                prefetch={true}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-sidebar-foreground" : "text-muted-foreground group-hover:text-sidebar-foreground"
                  )}
                />
                {!collapsed && <span>{item.name}</span>}
              </Link>
            )

            if (collapsed) {
              return (
                <Tooltip key={item.name}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.name}
                  </TooltipContent>
                </Tooltip>
              )
            }

            return link
          })}
        </nav>

        <Separator className="bg-sidebar-border" />

        {/* Bottom section */}
        <div className="space-y-1 p-2">
          {/* Workspace Switcher */}
          {!collapsed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:bg-sidebar-accent/50 transition-colors">
                  <span>{view === "admin" ? "Admin View" : "Operations View"}</span>
                  <ChevronsUpDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48">
                <DropdownMenuItem onClick={() => setView("admin")} className="gap-2">
                  {view === "admin" ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                  Admin View
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setView("operations")} className="gap-2">
                  {view === "operations" ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                  Operations View
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Theme toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="w-full justify-start gap-3 px-2.5 text-muted-foreground hover:text-sidebar-foreground"
              >
                {mounted && theme === "dark" ? (
                  <Sun className="h-4 w-4 shrink-0" />
                ) : (
                  <Moon className="h-4 w-4 shrink-0" />
                )}
                {!collapsed && (
                  <span className="text-xs">
                    {mounted && theme === "dark" ? "Light Mode" : "Dark Mode"}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={8}>
                Toggle Theme
              </TooltipContent>
            )}
          </Tooltip>

          {/* User Profile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-sidebar-accent/50 transition-colors">
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="bg-accent text-accent-foreground text-[10px]">
                    {profile.avatarInitials}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="flex flex-1 items-center justify-between">
                    <div className="text-left">
                      <p className="text-xs font-medium text-sidebar-foreground leading-none">
                        {profile.firstName} {profile.lastName}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 capitalize">
                        {profile.role}
                      </p>
                    </div>
                    <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
                  </div>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
              <DropdownMenuItem onClick={() => router.push("/profile")}>Profile</DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push("/settings")}>Account Settings</DropdownMenuItem>
              <DropdownMenuItem>Sign Out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  )
}
