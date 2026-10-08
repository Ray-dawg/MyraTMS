// Routes that render without the app shell (sidebar, topbar, etc.).
// Keep in sync with the public *page* paths in middleware.ts (/login, /rate/, /invite/).
export const BARE_ROUTES = ["/login", "/invite", "/rate"]

/** True when pathname is a bare route or nested under one (segment-aware). */
export function isBareRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))
}
