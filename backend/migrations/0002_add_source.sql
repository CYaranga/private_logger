-- Add source column to track where logs originate from
-- Common values: ios, android, web, desktop, backend, simulator, cli, api, watch, tv, extension, iot
ALTER TABLE logs ADD COLUMN source TEXT DEFAULT NULL;

-- Index for filtering by source
CREATE INDEX IF NOT EXISTS idx_logs_source ON logs(source);
