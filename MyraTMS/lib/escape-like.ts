/**
 * Escapes LIKE metacharacters (% and _) in a user-supplied string
 * so it matches literally in a SQL LIKE pattern.
 */
export function escapeLikeMeta(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}
