-- Adds rich context columns so non-technical team members can answer
-- "who did what, on which device, when, and what broke" without reading JSON.
--
-- session_id    : per-app-launch identifier; groups every log from one user session
-- trace_id      : optional sub-correlation across mobile → backend boundary
-- app_version   : client semver (e.g. "2.4.1")
-- os_version    : OS string (e.g. "iOS 17.5", "Android 14")
-- device_model  : marketing name (e.g. "iPhone 15 Pro", "Pixel 8")
-- network_type  : "wifi" | "cellular" | "none" | "unknown"
-- fingerprint   : stable hash for error grouping (level|category|endpoint|status|normalized message)
-- breadcrumbs   : JSON array of last N user actions before this log (newest last)

ALTER TABLE logs ADD COLUMN session_id TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN trace_id TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN app_version TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN os_version TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN device_model TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN network_type TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN fingerprint TEXT DEFAULT NULL;
ALTER TABLE logs ADD COLUMN breadcrumbs TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_logs_session_id ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_fingerprint ON logs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_logs_user_created ON logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_app_version ON logs(app_version);
