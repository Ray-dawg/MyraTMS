// Runs once per vitest worker before any test file. Fails the whole run fast
// if DATABASE_URL points at production — see lib/db/production-guard.ts.
import { assertNotProductionUnderTest } from "./lib/db/production-guard"

assertNotProductionUnderTest(process.env.DATABASE_URL)
