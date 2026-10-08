/** Tenant roles that may be chosen as a shipper's assigned rep. Single source of truth. */
export const ASSIGNABLE_REP_ROLES = ["owner", "admin", "operator"] as const

/**
 * SQL fragment for the role allow-list. Built only from the constant above
 * (no user input), so interpolation is safe.
 */
export const ASSIGNABLE_REP_ROLES_SQL = `tu.role IN (${ASSIGNABLE_REP_ROLES.map((r) => `'${r}'`).join(", ")})`
