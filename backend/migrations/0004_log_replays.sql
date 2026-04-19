-- Add table to store endpoint replay attempts (v2+) for logged API calls.
-- v1 is the original log row in `logs` and is not duplicated here.
CREATE TABLE IF NOT EXISTS log_replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_log_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  http_method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query_params TEXT,
  headers TEXT,
  request_data TEXT,
  response_data TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_log_id) REFERENCES logs(id) ON DELETE CASCADE,
  UNIQUE(parent_log_id, version)
);

CREATE INDEX IF NOT EXISTS idx_log_replays_parent ON log_replays(parent_log_id);
