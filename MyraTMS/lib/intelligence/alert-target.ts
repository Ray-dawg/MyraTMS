// Pure helpers for the AI Intelligence page.
//
// `affectedEntity` on a risk alert is free text produced by the LLM in
// /api/ai/analyze-risk (z.string().nullable()). It may be a load id, a carrier
// or shipper name, a sentence, or null. Resolve it defensively to a route that
// exists under app/ -- never to a guessed URL.
//
// Routes used (all verified to exist under MyraTMS/app):
//   /loads/[id]  /carriers/[id]  /shippers/[id]
//   /loads  /carriers  /shippers  /finance

export interface NamedEntity {
  id: string
  company: string
}

export interface AlertLike {
  severity: string
  title: string
  affectedEntity: string | null
  description?: string
}

export interface AlertTarget {
  href: string
  kind: "load" | "carrier" | "shipper" | "list"
  /**
   * Set for list fallbacks: the text the operator should search for. The list
   * pages keep their search box in local state and do not read URL params, so
   * this is surfaced by the caller (toast) rather than encoded in the URL.
   */
  search?: string
  /** Human label of what we navigated to, for toasts. */
  label: string
}

const LOAD_ID = /\bLD-[A-Z0-9]+\b/i

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

export function containsToken(haystack: string, needle: string): boolean {
  // An empty needle would make the indexOf loop below non-terminating
  // (indexOf("", n) clamps to haystack.length forever).
  if (!needle) return false
  // needle is already normalized; match on non-alphanumeric boundaries so that
  // "ACME" does not match inside "MACMEN".
  // Check every occurrence: the first one may sit inside a longer word
  // ("Swiftly") while a later one is a valid standalone mention ("Swift Inc").
  const isWord = (c: string) => /[a-z0-9]/.test(c)
  // Hard cap as defence in depth: there can be at most haystack.length
  // occurrences, so if the guard above is ever removed the loop aborts
  // instead of hanging the caller (or the test runner).
  let guard = haystack.length + 1
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
    if (guard-- <= 0) return false
    const before = idx === 0 ? "" : haystack[idx - 1]
    const after = haystack[idx + needle.length] ?? ""
    if (before && isWord(before)) continue
    if (after && isWord(after)) continue
    return true
  }
  return false
}

/** Longest company-name (or id) match inside `text`, or null. */
function findEntity(text: string, entities: NamedEntity[]): NamedEntity | null {
  let best: { entity: NamedEntity; score: number } | null = null
  for (const entity of entities) {
    const name = normalize(entity.company || "")
    const id = normalize(entity.id || "")
    let score = 0
    if (name.length >= 3 && containsToken(text, name)) score = name.length
    // An explicit id mention is stronger than any name.
    if (id.length >= 3 && containsToken(text, id)) score = Math.max(score, 1000 + id.length)
    if (score > 0 && (!best || score > best.score)) best = { entity, score }
  }
  return best?.entity ?? null
}

function fallbackList(text: string): Pick<AlertTarget, "href"> {
  const t = text.toLowerCase()
  if (/\b(invoice|invoices|payment|overdue|receivable|factoring)\b/.test(t)) return { href: "/finance" }
  if (/\b(carrier|carriers|authority|insurance|safety|compliance|mc#|mc number|dot)\b/.test(t)) return { href: "/carriers" }
  if (/\b(shipper|shippers|customer|customers)\b/.test(t)) return { href: "/shippers" }
  return { href: "/loads" }
}

const LIST_LABEL: Record<string, string> = {
  "/finance": "Finance",
  "/carriers": "Carriers",
  "/shippers": "Shippers",
  "/loads": "Loads",
}

export function resolveAlertTarget(
  alert: AlertLike,
  data: { carriers: NamedEntity[]; shippers: NamedEntity[] },
): AlertTarget {
  const entityText = (alert.affectedEntity ?? "").trim()
  // Prefer the dedicated entity field, but fall back to the title so an alert
  // with a null affectedEntity ("Low margin on LD-1234") still resolves.
  const sources = [entityText, alert.title ?? ""].filter(Boolean)

  for (const source of sources) {
    const load = source.match(LOAD_ID)
    if (load) {
      const id = load[0].toUpperCase()
      return { href: `/loads/${encodeURIComponent(id)}`, kind: "load", label: id }
    }
    const normalized = normalize(source)
    const carrier = findEntity(normalized, data.carriers)
    const shipper = findEntity(normalized, data.shippers)
    if (carrier || shipper) {
      // Longer / explicit match wins; carrier wins ties (alerts are mostly compliance).
      const carrierScore = carrier ? scoreOf(normalized, carrier) : 0
      const shipperScore = shipper ? scoreOf(normalized, shipper) : 0
      if (carrier && carrierScore >= shipperScore) {
        return { href: `/carriers/${encodeURIComponent(carrier.id)}`, kind: "carrier", label: carrier.company }
      }
      if (shipper) {
        return { href: `/shippers/${encodeURIComponent(shipper.id)}`, kind: "shipper", label: shipper.company }
      }
    }
  }

  const text = [entityText, alert.title ?? ""].join(" ")
  const { href } = fallbackList(text)
  return {
    href,
    kind: "list",
    search: entityText || undefined,
    label: LIST_LABEL[href] ?? href,
  }
}

function scoreOf(text: string, entity: NamedEntity): number {
  const id = normalize(entity.id || "")
  if (id.length >= 3 && containsToken(text, id)) return 1000 + id.length
  return normalize(entity.company || "").length
}

/**
 * Stable key for client-side dismissal. Must not depend on array index because
 * re-fetching /api/ai/analyze-risk can reorder alerts.
 */
export function alertKey(alert: AlertLike): string {
  // description is included: two alerts with the same severity/title/entity but
  // different descriptions (e.g. low margin on LD-1 vs LD-2) are distinct and
  // must not be collapsed by the dedupe in the page.
  // Each part is escaped before joining: a literal pipe inside LLM-authored
  // text would otherwise let two distinct alerts produce the same key and be
  // collapsed by the dedupe/dismissal in the page.
  return [alert.severity, alert.title, alert.affectedEntity ?? "", alert.description ?? ""]
    .map((p) => normalize(p ?? "").replace(/\|/g, "%7C"))
    .join("|")
}

export interface ActionNotice {
  level: "info" | "warning"
  message: string
}

/**
 * Toast to show alongside a "Take Action" navigation, or null when the target
 * resolved to a specific, known record. Never navigate silently when nothing
 * was actually matched.
 */
export function getActionNotice(target: AlertTarget, knownLoadIds: string[]): ActionNotice | null {
  if (target.kind === "list") {
    return {
      level: "info",
      message: target.search
        ? `No matching record found. Opened ${target.label}; search for "${target.search}".`
        : `No specific record to open. Showing ${target.label} — nothing has been actioned.`,
    }
  }
  if (target.kind === "load" && !knownLoadIds.includes(target.label)) {
    // Not validated hard: /api/loads is paginated, so an older active load may
    // legitimately be outside the list. Warn rather than block.
    return { level: "warning", message: `${target.label} isn't in your recent loads — it may not exist.` }
  }
  return null
}
