-- 021-check-call-reminder.sql
-- Seed default settings for the automated check-call reminder feature

INSERT INTO settings (id, user_id, settings_key, settings_value, updated_at)
VALUES ('setting-checkcall-threshold', NULL, 'checkcall_threshold_hours', '4', NOW())
ON CONFLICT (settings_key) WHERE user_id IS NULL DO NOTHING;

INSERT INTO settings (id, user_id, settings_key, settings_value, updated_at)
VALUES ('setting-checkcall-enabled', NULL, 'notif_checkcall_enabled', 'true', NOW())
ON CONFLICT (settings_key) WHERE user_id IS NULL DO NOTHING;
