import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Unit tests for lib/workflow-engine.ts
//
// We mock @/lib/db/tenant-context so no real database connection is needed.
// The engine reaches the database exclusively through withTenant(), so we
// stub that to invoke the callback with a fake PoolClient whose .query()
// is a vi mock. All tests exercise condition evaluation and action logic.
// ---------------------------------------------------------------------------

// Tenant id used in every test call. Real value irrelevant — the mock
// short-circuits the RLS-enforced tenant scoping.
const TENANT_ID = 2

// Mock the client.query() that the engine calls inside withTenant().
const mockClient = { query: vi.fn() }

vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(
    async <T,>(_tenantId: number, cb: (client: typeof mockClient) => Promise<T>) =>
      cb(mockClient),
  ),
}))

// Import AFTER mocking
import { executeWorkflows, type WorkflowContext } from "@/lib/workflow-engine"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockWorkflowRow {
  id: string
  name: string
  conditions: string | unknown[]
  actions: string | unknown[]
}

/**
 * Configure the mock client.query to return specific workflows on the first
 * call (the SELECT) and empty result sets on subsequent calls (INSERT/UPDATE
 * side-effects). Engine expects pg-style { rows: [...] } responses.
 */
function setupMockWorkflows(workflows: MockWorkflowRow[]) {
  let callCount = 0
  mockClient.query.mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      return Promise.resolve({ rows: workflows })
    }
    return Promise.resolve({ rows: [] })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Condition evaluation (tested indirectly through executeWorkflows)
// ---------------------------------------------------------------------------

describe("Condition evaluation via executeWorkflows", () => {
  it("fires workflow when 'equals' condition matches", async () => {
    setupMockWorkflows([
      {
        id: "wf-1",
        name: "Status Equals Test",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "equals", value: "Delivered" },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Load delivered!", notificationType: "success" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", {
      loadId: "LD-001",
      oldStatus: "In Transit",
      newStatus: "Delivered",
    })

    // SELECT workflows + INSERT notification + UPDATE workflow metadata = 3 calls
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("does NOT fire workflow when 'equals' condition does not match", async () => {
    setupMockWorkflows([
      {
        id: "wf-2",
        name: "No Match Test",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "equals", value: "Cancelled" },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Should not fire" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", {
      loadId: "LD-001",
      newStatus: "Delivered",
    })

    // Only the SELECT query should fire; no actions executed
    expect(mockClient.query).toHaveBeenCalledTimes(1)
  })

  it("fires workflow when 'not_equals' condition matches", async () => {
    setupMockWorkflows([
      {
        id: "wf-3",
        name: "Not Equals Test",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "not_equals", value: "Cancelled" },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Not cancelled" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { newStatus: "Delivered" })

    // SELECT + INSERT notification + UPDATE metadata
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("fires workflow when 'contains' condition matches (case-insensitive)", async () => {
    setupMockWorkflows([
      {
        id: "wf-4",
        name: "Contains Test",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "contains", value: "transit" },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "In transit!" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { newStatus: "In Transit" })

    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("does NOT fire when 'contains' condition does not match", async () => {
    setupMockWorkflows([
      {
        id: "wf-5",
        name: "Contains No Match",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "contains", value: "cancel" },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Should not fire" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { newStatus: "Delivered" })

    expect(mockClient.query).toHaveBeenCalledTimes(1)
  })

  it("fires workflow when 'greater_than' condition matches", async () => {
    setupMockWorkflows([
      {
        id: "wf-6",
        name: "Greater Than Test",
        conditions: JSON.stringify([
          { field: "margin", operator: "greater_than", value: 1000 },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "High margin load!" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"load_created", { margin: 2500 } as WorkflowContext)

    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("does NOT fire when 'greater_than' condition fails", async () => {
    setupMockWorkflows([
      {
        id: "wf-7",
        name: "Greater Than Fail",
        conditions: JSON.stringify([
          { field: "margin", operator: "greater_than", value: 5000 },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Should not fire" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"load_created", { margin: 2500 } as WorkflowContext)

    expect(mockClient.query).toHaveBeenCalledTimes(1)
  })

  it("fires workflow when 'less_than' condition matches", async () => {
    setupMockWorkflows([
      {
        id: "wf-8",
        name: "Less Than Test",
        conditions: JSON.stringify([
          { field: "margin", operator: "less_than", value: 500 },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Low margin warning!" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"load_created", { margin: 200 } as WorkflowContext)

    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("requires ALL conditions to pass (AND logic)", async () => {
    setupMockWorkflows([
      {
        id: "wf-9",
        name: "Multi-Condition AND",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "equals", value: "Delivered" },
          { field: "margin", operator: "greater_than", value: 1000 },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Delivered + high margin" },
          },
        ]),
      },
    ])

    // Only one condition matches (status matches, but margin is too low)
    await executeWorkflows(TENANT_ID,"status_change", {
      newStatus: "Delivered",
      margin: 500,
    } as WorkflowContext)

    // Only SELECT fires; no action because AND fails
    expect(mockClient.query).toHaveBeenCalledTimes(1)
  })

  it("fires when ALL conditions pass", async () => {
    setupMockWorkflows([
      {
        id: "wf-10",
        name: "Both Match",
        conditions: JSON.stringify([
          { field: "newStatus", operator: "equals", value: "Delivered" },
          { field: "margin", operator: "greater_than", value: 1000 },
        ]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Both matched" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", {
      newStatus: "Delivered",
      margin: 2000,
    } as WorkflowContext)

    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("fires when conditions array is empty (always match)", async () => {
    setupMockWorkflows([
      {
        id: "wf-11",
        name: "No Conditions",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Always fires" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"any_trigger", {})

    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Action execution (tested indirectly through executeWorkflows)
// ---------------------------------------------------------------------------

describe("Action execution via executeWorkflows", () => {
  it("executes send_email action (inserts notification)", async () => {
    setupMockWorkflows([
      {
        id: "wf-email",
        name: "Email Action",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "send_email",
            config: {
              to: "ops@myratms.com",
              subject: "Load delivered",
              body: "Load LD-001 has been delivered.",
            },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { loadId: "LD-001", newStatus: "Delivered" })

    // SELECT + INSERT (send_email creates notification) + UPDATE metadata
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("executes update_status action", async () => {
    setupMockWorkflows([
      {
        id: "wf-status",
        name: "Auto Status Update",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "update_status",
            config: { status: "Invoiced" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { loadId: "LD-001" })

    // SELECT + UPDATE loads (update_status) + UPDATE workflows metadata
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("executes assign_carrier action", async () => {
    setupMockWorkflows([
      {
        id: "wf-assign",
        name: "Auto Assign Carrier",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "assign_carrier",
            config: { carrierId: "CAR-001" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"load_created", { loadId: "LD-002" })

    // SELECT + UPDATE loads (assign_carrier) + UPDATE workflows metadata
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("skips update_status when loadId is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    setupMockWorkflows([
      {
        id: "wf-no-load",
        name: "Missing LoadId",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "update_status",
            config: { status: "Invoiced" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", {})

    // SELECT + UPDATE metadata only (no UPDATE loads because loadId is missing)
    expect(mockClient.query).toHaveBeenCalledTimes(2)

    warnSpy.mockRestore()
  })

  it("executes multiple actions in sequence", async () => {
    setupMockWorkflows([
      {
        id: "wf-multi",
        name: "Multiple Actions",
        conditions: JSON.stringify([]),
        actions: JSON.stringify([
          {
            type: "create_notification",
            config: { title: "Action 1" },
          },
          {
            type: "create_notification",
            config: { title: "Action 2" },
          },
        ]),
      },
    ])

    await executeWorkflows(TENANT_ID,"status_change", { loadId: "LD-001" })

    // SELECT + INSERT notif 1 + INSERT notif 2 + UPDATE metadata = 4 calls
    expect(mockClient.query).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Workflow engine edge cases", () => {
  it("does nothing when no workflows match the trigger", async () => {
    setupMockWorkflows([])

    await executeWorkflows(TENANT_ID,"status_change", { loadId: "LD-001" })

    expect(mockClient.query).toHaveBeenCalledTimes(1) // just the SELECT
  })

  it("handles conditions stored as already-parsed objects", async () => {
    // The workflow engine handles both JSON string and pre-parsed conditions
    let callCount = 0
    mockClient.query.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          rows: [
            {
              id: "wf-parsed",
              name: "Pre-parsed",
              // Already parsed (not a string)
              conditions: [
                { field: "newStatus", operator: "equals", value: "Delivered" },
              ],
              actions: [
                {
                  type: "create_notification",
                  config: { title: "Pre-parsed test" },
                },
              ],
            },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    await executeWorkflows(TENANT_ID,"status_change", { newStatus: "Delivered" })

    // SELECT + INSERT notification + UPDATE metadata
    expect(mockClient.query).toHaveBeenCalledTimes(3)
  })

  it("continues processing remaining workflows if one throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    let callCount = 0
    mockClient.query.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          rows: [
            {
              id: "wf-fail",
              name: "Failing Workflow",
              conditions: JSON.stringify([]),
              actions: "INVALID_JSON{{{", // will fail JSON.parse
            },
            {
              id: "wf-ok",
              name: "OK Workflow",
              conditions: JSON.stringify([]),
              actions: JSON.stringify([
                {
                  type: "create_notification",
                  config: { title: "I should still fire" },
                },
              ]),
            },
          ],
        })
      }
      return Promise.resolve({ rows: [] })
    })

    // Should NOT throw even though one workflow has invalid JSON
    await executeWorkflows(TENANT_ID,"status_change", {})

    // SELECT + INSERT notification (wf-ok) + UPDATE metadata (wf-ok) = 3 calls
    // wf-fail throws on JSON.parse, caught internally
    expect(mockClient.query).toHaveBeenCalledTimes(3)

    errorSpy.mockRestore()
  })

  it("never throws to the caller even on fatal DB errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    mockClient.query.mockImplementation(() => {
      return Promise.reject(new Error("Database connection failed"))
    })

    // Should NOT throw
    await expect(
      executeWorkflows(TENANT_ID, "status_change", { loadId: "LD-001" })
    ).resolves.toBeUndefined()

    errorSpy.mockRestore()
  })
})
