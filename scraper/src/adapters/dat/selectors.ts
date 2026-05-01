/**
 * DAT DOM selectors. **All env-overridable** because DAT will rebrand and
 * rewire its UI without notice. Defaults are best-effort against DAT Power
 * (https://power.dat.com) circa 2026 — verify against the live UI on the
 * very first run.
 *
 * When DAT changes a selector, the fix is `DAT_SEL_<NAME>=<new selector>`
 * in Railway env, then redeploy. No code change required.
 */

export const DAT_SELECTORS = {
  // ── Login page ──────────────────────────────────────────────────
  username:
    process.env.DAT_SEL_USERNAME ||
    'input[name="username"], input#username, input[type="email"]',
  password:
    process.env.DAT_SEL_PASSWORD ||
    'input[name="password"], input#password, input[type="password"]',
  loginButton:
    process.env.DAT_SEL_LOGIN_BUTTON ||
    'button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")',
  mfaInput:
    process.env.DAT_SEL_MFA_INPUT ||
    'input[name="otp"], input[name="code"], input[autocomplete="one-time-code"]',
  loginError:
    process.env.DAT_SEL_LOGIN_ERROR ||
    '[role="alert"], .error-message, .alert-danger',

  // ── Authenticated probe — element that ONLY appears when logged in
  authenticatedMarker:
    process.env.DAT_SEL_AUTH_MARKER ||
    '[data-test="user-menu"], .user-profile, button:has-text("Sign Out")',

  // ── Search form ─────────────────────────────────────────────────
  equipmentDropdown:
    process.env.DAT_SEL_EQUIPMENT || '[data-test="equipment-select"]',
  originInput:
    process.env.DAT_SEL_ORIGIN ||
    'input[name="origin"], [data-test="origin-input"]',
  destinationInput:
    process.env.DAT_SEL_DESTINATION ||
    'input[name="destination"], [data-test="destination-input"]',
  pickupDateFrom:
    process.env.DAT_SEL_DATE_FROM ||
    'input[name="pickupDateFrom"], [data-test="date-from"]',
  pickupDateTo:
    process.env.DAT_SEL_DATE_TO ||
    'input[name="pickupDateTo"], [data-test="date-to"]',
  searchSubmit:
    process.env.DAT_SEL_SEARCH_SUBMIT ||
    'button[type="submit"]:has-text("Search"), [data-test="search-button"]',

  // ── Results table ───────────────────────────────────────────────
  resultsTable:
    process.env.DAT_SEL_RESULTS_TABLE ||
    'table[data-test="results"], table.results-table, [role="grid"]',
  resultRow:
    process.env.DAT_SEL_RESULT_ROW ||
    'tr[data-test="result-row"], tbody tr',
  loadingSpinner:
    process.env.DAT_SEL_LOADING ||
    '[data-test="loading"], .loading-spinner',

  // ── Per-row fields ─────────────────────────────────────────────
  cellLoadId:      process.env.DAT_SEL_CELL_ID         || '[data-field="id"], td:nth-child(1)',
  cellOrigin:      process.env.DAT_SEL_CELL_ORIGIN     || '[data-field="origin"]',
  cellDestination: process.env.DAT_SEL_CELL_DEST       || '[data-field="destination"]',
  cellEquipment:   process.env.DAT_SEL_CELL_EQUIPMENT  || '[data-field="equipment"]',
  cellPickupDate:  process.env.DAT_SEL_CELL_PICKUP     || '[data-field="pickupDate"]',
  cellWeight:      process.env.DAT_SEL_CELL_WEIGHT     || '[data-field="weight"]',
  cellLength:      process.env.DAT_SEL_CELL_LENGTH     || '[data-field="length"]',
  cellRate:        process.env.DAT_SEL_CELL_RATE       || '[data-field="rate"]',
  cellBroker:      process.env.DAT_SEL_CELL_BROKER     || '[data-field="broker"]',
  cellPhone:       process.env.DAT_SEL_CELL_PHONE      || '[data-field="phone"]',
} as const;
