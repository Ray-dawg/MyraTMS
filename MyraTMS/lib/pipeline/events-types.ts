export interface EventRow {
  id: number;
  tenant_id: number;
  event_type: string;
  entity_type: string;
  entity_id: number;
  pipeline_load_id: number | null;
  source: string;
  actor_type: string;
  payload: Record<string, unknown>;
  stage_from: string | null;
  stage_to: string | null;
  occurred_at: string;
  recorded_at: string;
  derived_from_table: string;
  derived_from_id: number;
  correlation_id: string | null;
}
