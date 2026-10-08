import { neon } from "@neondatabase/serverless"
import { assertNotProductionUnderTest } from "@/lib/db/production-guard"

export function getDb() {
  assertNotProductionUnderTest(process.env.DATABASE_URL)
  return neon(process.env.DATABASE_URL!)
}
