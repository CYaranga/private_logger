-- API tokens for service accounts and agent (MCP) access. Token plaintext
-- has shape `pl_live_<32 base62 chars>`; only its SHA-256 hash is stored.
-- The first 12 plaintext chars are kept in `prefix` for display so users
-- can recognise which token is which without revealing it.

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  name        TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME,
  last_used   DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
