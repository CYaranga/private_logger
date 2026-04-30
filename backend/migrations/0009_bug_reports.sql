-- Mobile bug reports. Single user installation so no rate limit / auth
-- on POST. Screenshot lives in R2 (binding SCREENSHOTS), not in this row.
-- related_log_ids is a JSON array of log ids around the report time so
-- agents can fetch context with one query.

CREATE TABLE IF NOT EXISTS bug_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  session_id      TEXT,
  severity        TEXT CHECK(severity IN ('low','medium','high','critical')) DEFAULT 'medium',
  description     TEXT NOT NULL,
  device_model    TEXT,
  os_version      TEXT,
  app_version     TEXT,
  network_type    TEXT,
  breadcrumbs     TEXT,
  related_log_ids TEXT,
  screenshot_url  TEXT,
  status          TEXT CHECK(status IN ('new','triaged','in_progress','resolved','wontfix')) DEFAULT 'new',
  assigned_to     TEXT,
  note            TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bugs_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bugs_user ON bug_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_bugs_session ON bug_reports(session_id);
CREATE INDEX IF NOT EXISTS idx_bugs_created ON bug_reports(created_at DESC);
