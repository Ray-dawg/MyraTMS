"use client"

import { useTheme } from "@/lib/theme-context"
import { Sun, Moon, Zap } from "lucide-react"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card/50 p-1">
      <button
        onClick={() => setTheme("dark-orange")}
        className={`flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors ${
          theme === "dark-orange"
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Dark + Orange"
        aria-label="Dark theme with orange accent"
      >
        <Moon className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => setTheme("light")}
        className={`flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors ${
          theme === "light"
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Light + Orange"
        aria-label="Light theme with orange accent"
      >
        <Sun className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => setTheme("light-purple")}
        className={`flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors ${
          theme === "light-purple"
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Light + Purple"
        aria-label="Light theme with purple accent"
      >
        <Zap className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
