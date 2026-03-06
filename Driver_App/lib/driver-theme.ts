// Driver App Theme — aligned with MyraTMS accent (hue 250 blue)
// Replaces the original teal palette with enterprise blue

export const T = {
  // Backgrounds
  bg: "#080d14",
  surface: "rgba(12, 20, 33, 0.96)",

  // Borders
  borderMuted: "rgba(255, 255, 255, 0.06)",
  border: "rgba(59, 130, 246, 0.12)",

  // Primary accent — blue, aligned with MyraTMS oklch(0.55 0.08 250)
  accent: "#3b82f6",
  accentDim: "rgba(59, 130, 246, 0.12)",
  accentGlow: "rgba(59, 130, 246, 0.28)",
  accentDark: "#2563eb",
  accentGradient: "linear-gradient(135deg, #3b82f6, #2563eb)",

  // Semantic colors
  blue: "#60a5fa",
  blueDim: "rgba(96, 165, 250, 0.12)",
  amber: "#f59e0b",
  amberDim: "rgba(245, 158, 11, 0.12)",
  red: "#f87171",
  redDim: "rgba(248, 113, 113, 0.12)",
  green: "#34d399",
  greenDim: "rgba(52, 211, 153, 0.12)",
  purple: "#a78bfa",
  purpleDim: "rgba(167, 139, 250, 0.12)",

  // Text
  textPrimary: "#f0f4f8",
  textSecondary: "rgba(240, 244, 248, 0.55)",
  textMuted: "rgba(240, 244, 248, 0.3)",
} as const

export type Theme = typeof T

/** Format ISO date string for display */
export function fmt(dateStr: string | null | undefined): string {
  if (!dateStr) return "TBD"
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  } catch {
    return dateStr
  }
}
