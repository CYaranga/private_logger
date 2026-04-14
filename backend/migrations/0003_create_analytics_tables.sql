CREATE TABLE IF NOT EXISTS behaviour_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  device_id   TEXT,
  action      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  screen      TEXT,
  metadata    TEXT,
  environment TEXT DEFAULT 'dev',
  source      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user   ON behaviour_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_action ON behaviour_events(action, subject);
CREATE INDEX IF NOT EXISTS idx_events_date   ON behaviour_events(created_at);

CREATE TABLE IF NOT EXISTS daily_aggregates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject      TEXT NOT NULL,
  environment  TEXT DEFAULT 'dev',
  source       TEXT,
  count        INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  UNIQUE(date, action, subject, environment, source)
);
CREATE INDEX IF NOT EXISTS idx_agg_date ON daily_aggregates(date);

CREATE TABLE IF NOT EXISTS daily_users (
  date        TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  environment TEXT DEFAULT 'dev',
  source      TEXT,
  UNIQUE(date, action, subject, user_id, environment, source)
);
