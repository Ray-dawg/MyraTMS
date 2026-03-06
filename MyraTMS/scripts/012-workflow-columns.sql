-- 012-workflow-columns.sql
-- Add columns referenced by the workflow PATCH route and workflow engine.

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_run TIMESTAMPTZ;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS runs_today INT DEFAULT 0;
