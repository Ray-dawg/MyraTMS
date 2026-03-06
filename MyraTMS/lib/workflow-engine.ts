// ---------------------------------------------------------------------------
// Workflow Engine for MyraTMS
//
// Executes workflows when triggers fire. Called by API routes (e.g., load
// status changes) to evaluate conditions and run actions automatically.
//
// Usage:
//   import { executeWorkflows } from "@/lib/workflow-engine"
//   await executeWorkflows("status_change", { loadId, oldStatus, newStatus })
// ---------------------------------------------------------------------------

import { getDb } from "@/lib/db"

export interface WorkflowContext {
  loadId?: string
  carrierId?: string
  invoiceId?: string
  oldStatus?: string
  newStatus?: string
  [key: string]: unknown
}

interface WorkflowCondition {
  field: string
  operator: "equals" | "not_equals" | "contains" | "greater_than" | "less_than"
  value: unknown
}

interface WorkflowAction {
  type: "send_email" | "create_notification" | "update_status" | "assign_carrier"
  config: Record<string, unknown>
}

interface WorkflowRow {
  id: string
  name: string
  conditions: WorkflowCondition[] | string
  actions: WorkflowAction[] | string
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(condition: WorkflowCondition, context: WorkflowContext): boolean {
  const fieldValue = context[condition.field]
  const targetValue = condition.value

  switch (condition.operator) {
    case "equals":
      return String(fieldValue) === String(targetValue)

    case "not_equals":
      return String(fieldValue) !== String(targetValue)

    case "contains":
      return String(fieldValue ?? "")
        .toLowerCase()
        .includes(String(targetValue).toLowerCase())

    case "greater_than":
      return Number(fieldValue) > Number(targetValue)

    case "less_than":
      return Number(fieldValue) < Number(targetValue)

    default:
      console.warn(`[workflow-engine] Unknown operator: ${condition.operator}`)
      return false
  }
}

function evaluateConditions(conditions: WorkflowCondition[], context: WorkflowContext): boolean {
  // All conditions must pass (AND logic). Empty conditions = always match.
  if (!conditions || conditions.length === 0) return true
  return conditions.every((c) => evaluateCondition(c, context))
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

async function executeAction(
  action: WorkflowAction,
  context: WorkflowContext,
  workflowName: string
): Promise<void> {
  const sql = getDb()

  switch (action.type) {
    case "send_email": {
      // Insert a notification to record the email intent + log it.
      // Actual SMTP sending is not done here to keep the engine lightweight;
      // the notification serves as the audit trail.
      const config = action.config as { to?: string; subject?: string; body?: string }
      const title = config.subject || `Email from workflow: ${workflowName}`
      const description = config.body || `Email to ${config.to || "unknown"}`

      await sql`
        INSERT INTO notifications (title, description, type, read, created_at)
        VALUES (${title}, ${description}, 'info', false, NOW())
      `
      console.log(`[workflow-engine] send_email action: "${title}" to ${config.to || "unknown"}`)
      break
    }

    case "create_notification": {
      const config = action.config as {
        title?: string
        description?: string
        notificationType?: string
      }
      const title = config.title || `Notification from workflow: ${workflowName}`
      const description = config.description || ""
      const notificationType = config.notificationType || "info"

      await sql`
        INSERT INTO notifications (title, description, type, read, created_at)
        VALUES (${title}, ${description}, ${notificationType}, false, NOW())
      `
      console.log(`[workflow-engine] create_notification: "${title}"`)
      break
    }

    case "update_status": {
      const config = action.config as { status?: string }
      if (!config.status || !context.loadId) {
        console.warn("[workflow-engine] update_status: missing status or loadId")
        break
      }
      await sql`
        UPDATE loads SET status = ${config.status}, updated_at = NOW()
        WHERE id = ${context.loadId}
      `
      console.log(
        `[workflow-engine] update_status: load ${context.loadId} -> ${config.status}`
      )
      break
    }

    case "assign_carrier": {
      const config = action.config as { carrierId?: string }
      if (!config.carrierId || !context.loadId) {
        console.warn("[workflow-engine] assign_carrier: missing carrierId or loadId")
        break
      }
      await sql`
        UPDATE loads SET carrier_id = ${config.carrierId}, updated_at = NOW()
        WHERE id = ${context.loadId}
      `
      console.log(
        `[workflow-engine] assign_carrier: load ${context.loadId} -> carrier ${config.carrierId}`
      )
      break
    }

    default:
      console.warn(`[workflow-engine] Unknown action type: ${action.type}`)
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeWorkflows(
  triggerType: string,
  context: WorkflowContext
): Promise<void> {
  try {
    const sql = getDb()

    // 1. Query active workflows matching the trigger type
    const workflows = await sql`
      SELECT id, name, conditions, actions
      FROM workflows
      WHERE active = true AND trigger_type = ${triggerType}
    ` as unknown as WorkflowRow[]

    if (workflows.length === 0) return

    for (const workflow of workflows) {
      try {
        // Parse conditions & actions (may be JSON strings or already parsed)
        const conditions: WorkflowCondition[] =
          typeof workflow.conditions === "string"
            ? JSON.parse(workflow.conditions)
            : (workflow.conditions ?? [])

        const actions: WorkflowAction[] =
          typeof workflow.actions === "string"
            ? JSON.parse(workflow.actions)
            : (workflow.actions ?? [])

        // 2. Evaluate conditions
        if (!evaluateConditions(conditions, context)) {
          continue // conditions not met, skip this workflow
        }

        // 3. Execute actions
        for (const action of actions) {
          await executeAction(action, context, workflow.name)
        }

        // 4. Update workflow metadata
        await sql`
          UPDATE workflows
          SET updated_at = NOW(),
              last_run = NOW(),
              runs_today = COALESCE(runs_today, 0) + 1
          WHERE id = ${workflow.id}
        `

        console.log(`[workflow-engine] Executed workflow "${workflow.name}" (${workflow.id})`)
      } catch (err) {
        console.error(
          `[workflow-engine] Error executing workflow "${workflow.name}" (${workflow.id}):`,
          err
        )
        // Continue to next workflow -- never throw
      }
    }
  } catch (err) {
    console.error("[workflow-engine] Fatal error querying workflows:", err)
    // Never throw -- callers should not fail because of workflow issues
  }
}
