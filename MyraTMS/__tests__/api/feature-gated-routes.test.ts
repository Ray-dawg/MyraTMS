// Server-side feature gating for tier-gated pages (Gap 1).
// Starter tenants must get the gateErrorResponse() 403 shape; pro/enterprise
// must pass through to the handler. DB, Redis and auth are mocked — the gate
// is exercised through the real lib/features/{gate,route-gate}.ts.
import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { resolveSubscription } from "@/lib/features/gate"
import type { Tier } from "@/lib/features"

const state = vi.hoisted(() => ({ tier: "starter" as string }))

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(() => ({
    userId: "u1", email: "t@x.com", role: "admin", firstName: "T", lastName: "U",
    tenantId: 2, tenantIds: [2],
  })),
  requireTenantContext: vi.fn(() => ({ tenantId: 2, role: "admin", userId: "u1", isSuperAdmin: false })),
}))

vi.mock("@/lib/features/loader", () => ({
  loadTenantSubscription: vi.fn(async (tenantId: number) =>
    resolveSubscription(tenantId, state.tier as Tier, "active", null),
  ),
}))

const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: "wf-1", name: "WF" }] }))
vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(async (_tid: number, fn: (c: { query: typeof query }) => unknown) => fn({ query })),
}))

vi.mock("@/lib/redis", () => ({
  getCached: vi.fn(async () => null),
  setCache: vi.fn(async () => undefined),
}))

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ output: { riskAlerts: [], overallRiskScore: 0, summary: "ok" } })),
  Output: { object: vi.fn(() => ({})) },
}))

import { GET as listWorkflows, POST as createWorkflow } from "@/app/api/workflows/route"
import { GET as getWorkflow, PATCH as patchWorkflow, DELETE as deleteWorkflow } from "@/app/api/workflows/[id]/route"
import { POST as searchLoadboard } from "@/app/api/loadboard/search/route"
import { POST as importLoadboard } from "@/app/api/loadboard/import/route"
import { POST as analyzeRisk } from "@/app/api/ai/analyze-risk/route"

const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://x${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const params = { params: Promise.resolve({ id: "wf-1" }) }

type Case = { name: string; feature: string; call: () => Promise<Response>; okStatus: number }
const cases: Case[] = [
  { name: "GET /api/workflows", feature: "tms_advanced", call: () => listWorkflows(req("/api/workflows", "GET")), okStatus: 200 },
  { name: "POST /api/workflows", feature: "tms_advanced", call: () => createWorkflow(req("/api/workflows", "POST", { name: "WF", triggerType: "status_change" })), okStatus: 201 },
  { name: "GET /api/workflows/[id]", feature: "tms_advanced", call: () => getWorkflow(req("/api/workflows/wf-1", "GET"), params), okStatus: 200 },
  { name: "PATCH /api/workflows/[id]", feature: "tms_advanced", call: () => patchWorkflow(req("/api/workflows/wf-1", "PATCH", { name: "WF2" }), params), okStatus: 200 },
  { name: "DELETE /api/workflows/[id]", feature: "tms_advanced", call: () => deleteWorkflow(req("/api/workflows/wf-1", "DELETE"), params), okStatus: 200 },
  { name: "POST /api/loadboard/search", feature: "autobroker_pro", call: () => searchLoadboard(req("/api/loadboard/search", "POST", {})), okStatus: 200 },
  { name: "POST /api/ai/analyze-risk", feature: "data_lane_intelligence", call: () => analyzeRisk(req("/api/ai/analyze-risk", "POST")), okStatus: 200 },
  { name: "POST /api/loadboard/import", feature: "autobroker_pro", call: () => importLoadboard(req("/api/loadboard/import", "POST", { origin: "A", destination: "B", rate: 1000 })), okStatus: 201 },
]

beforeEach(() => {
  query.mockClear()
  delete process.env.DAT_API_KEY
  delete process.env.TRUCKSTOP_API_KEY
})

describe.each(cases)("$name", ({ feature, call, okStatus }) => {
  it("starter tier → 403 feature_unavailable, handler never touches the DB", async () => {
    state.tier = "starter"
    const res = await call()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toMatchObject({ code: "feature_unavailable", feature, tier: "starter" })
    expect(query).not.toHaveBeenCalled()
  })

  it.each(["pro", "enterprise"])("%s tier → passes through to the handler", async (tier) => {
    state.tier = tier
    const res = await call()
    expect(res.status).toBe(okStatus)
  })
})
