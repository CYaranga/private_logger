-- Per-fingerprint state so error groups can be triaged. Without this,
-- the same group keeps appearing in the dashboard every week even after
-- it has been investigated or assigned.
--
-- status:
--   "open"       — default; appears in default error list
--   "ignored"    — known-noise / wontfix; hidden from default view
--   "resolved"   — fixed in a release; surfaces again only if it recurs
--   "monitoring" — under investigation, keep visible but flagged

CREATE TABLE IF NOT EXISTS error_group_states (
  fingerprint   TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','ignored','resolved','monitoring')),
  assigned_to   TEXT,
  note          TEXT,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_egs_status ON error_group_states(status);
CREATE INDEX IF NOT EXISTS idx_egs_assigned ON error_group_states(assigned_to);
