-- Mirror the rich-context columns added to logs (0005) onto behaviour_events
-- so user-behaviour dashboards can slice by session, app version, OS version,
-- and device model. Required for "which build did this funnel drop on?"
-- and per-session journey reconstruction.

ALTER TABLE behaviour_events ADD COLUMN session_id TEXT DEFAULT NULL;
ALTER TABLE behaviour_events ADD COLUMN app_version TEXT DEFAULT NULL;
ALTER TABLE behaviour_events ADD COLUMN os_version TEXT DEFAULT NULL;
ALTER TABLE behaviour_events ADD COLUMN device_model TEXT DEFAULT NULL;
ALTER TABLE behaviour_events ADD COLUMN network_type TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_events_session ON behaviour_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_app_ver ON behaviour_events(app_version);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON behaviour_events(user_id, created_at DESC);

-- Per-version funnel slice. Same shape as daily_aggregates but partitioned
-- by app_version so non-tech teammates can answer "did the new build break
-- check-in?" by comparing rows for the same (action, subject) across versions.
CREATE TABLE IF NOT EXISTS daily_aggregates_by_version (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  environment   TEXT DEFAULT 'dev',
  source        TEXT,
  app_version   TEXT,
  count         INTEGER DEFAULT 0,
  unique_users  INTEGER DEFAULT 0,
  UNIQUE(date, action, subject, environment, source, app_version)
);
CREATE INDEX IF NOT EXISTS idx_agg_v_date ON daily_aggregates_by_version(date);
CREATE INDEX IF NOT EXISTS idx_agg_v_app ON daily_aggregates_by_version(app_version);
