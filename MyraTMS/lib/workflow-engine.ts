// ---------------------------------------------------------------------------
// Workflow Engine for MyraTMS
//
// Executes workflows when triggers fire. Called by API routes (e.g., load
// status changes) to evaluate conditions and run actions automatically.
//
// Usage:
//   import { executeWorkflows } from "@/lib/workflow-engine"
//   await executeWorkflows(tenantId, "status_change", { loadId, oldStatus, newStatus })
// ---------------------------------------------------------------------------

import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"

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

function evaluateCondition(condition: WorkflowCondition, context: WorkflowContext): boolean {
  const fieldValue = context[condition.field]
  const targetValue = condition.value

  switch (condition.operator) {
    case "equals":
      return String(fieldValue) === String(targetValue)
    case "not_equals":
      return String(fieldValue) !== String(targetValue)
    case "contains":
      return String(fieldValue ?? "").toLowerCase().includes(String(targetValue).toLowerCase())
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
  if (!conditions || conditions.length === 0) return true
  return conditions.every((c) => evaluateCondition(c, context))
}

async function executeAction(
  client: PoolClient,
  action: WorkflowAction,
  context: WorkflowContext,
  workflowName: string,
): Promise<void> {
  switch (action.type) {
    case "send_email": {
      const config = action.config as { to?: string; subject?: string; body?: string }
      const title = config.subject || `Email from workflow: ${workflowName}`
      const description = config.body || `Email to ${config.to || "unknown"}`
      await client.query(
        `INSERT INTO notifications (title, body, type, read, created_at)
         VALUES ($1, $2, 'info', false, NOW())`,
        [title, description],
      )
      console.log(`[workflow-engine] send_email action: "${title}" to ${config.to || "unknown"}`)
      break
    }

    case "create_notification": {
      const config = action.config as { title?: string; description?: string; notificationType?: string }
      const title = config.title || `Notification from workflow: ${workflowName}`
      const description = config.description || ""
      const notificationType = config.notificationType || "info"
      await client.query(
        `INSERT INTO notifications (title, body, type, read, created_at)
         VALUES ($1, $2, $3, false, NOW())`,
        [title, description, notificationType],
      )
      console.log(`[workflow-engine] create_notification: "${title}"`)
      break
    }

    case "update_status": {
      const config = action.config as { status?: string }
      if (!config.status || !context.loadId) {
        console.warn("[workflow-engine] update_status: missing status or loadId")
        break
      }
      await client.query(
        `UPDATE loads SET status = $1, updated_at = NOW() WHERE id = $2`,
        [config.status, context.loadId],
      )
      console.log(`[workflow-engine] update_status: load ${context.loadId} -> ${config.status}`)
      break
    }

    case "assign_carrier": {
      const config = action.config as { carrierId?: string }
      if (!config.carrierId || !context.loadId) {
        console.warn("[workflow-engine] assign_carrier: missing carrierId or loadId")
        break
      }
      await client.query(
        `UPDATE loads SET carrier_id = $1, updated_at = NOW() WHERE id = $2`,
        [config.carrierId, context.loadId],
      )
      console.log(`[workflow-engine] assign_carrier: load ${context.loadId} -> carrier ${config.carrierId}`)
      break
    }

    default:
      console.warn(`[workflow-engine] Unknown action type: ${(action as { type: string }).type}`)
  }
}

export async function executeWorkflows(
  tenantId: number,
  triggerType: string,
  context: WorkflowContext,
): Promise<void> {
  try {
    await withTenant(tenantId, async (client) => {
      const { rows } = await client.query<WorkflowRow>(
        `SELECT id, name, conditions, actions
           FROM workflows
          WHERE active = true AND trigger_type = $1`,
        [triggerType],
      )

      if (rows.length === 0) return

      for (const workflow of rows) {
        try {
          const conditions: WorkflowCondition[] =
            typeof workflow.conditions === "string"
              ? JSON.parse(workflow.conditions)
              : (workflow.conditions ?? [])

          const actions: WorkflowAction[] =
            typeof workflow.actions === "string"
              ? JSON.parse(workflow.actions)
              : (workflow.actions ?? [])

          if (!evaluateConditions(conditions, context)) continue

          for (const action of actions) {
            await executeAction(client, action, context, workflow.name)
          }

          await client.query(
            `UPDATE workflows
                SET updated_at = NOW(),
                    last_run = NOW(),
                    runs_today = COALESCE(runs_today, 0) + 1
              WHERE id = $1`,
            [workflow.id],
          )

          console.log(`[workflow-engine] Executed workflow "${workflow.name}" (${workflow.id})`)
        } catch (err) {
          console.error(
            `[workflow-engine] Error executing workflow "${workflow.name}" (${workflow.id}):`,
            err,
          )
        }
      }
    })
  } catch (err) {
    console.error("[workflow-engine] Fatal error querying workflows:", err)
  }
}
