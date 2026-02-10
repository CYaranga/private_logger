-- Add users table for authentication
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add sessions table for session management
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create index for faster session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Insert admin user (password: C@tolica/20121298)
-- Password hashed with PBKDF2 (100,000 iterations, SHA-256)
INSERT OR IGNORE INTO users (username, password_hash) VALUES (
  'admin',
  '29c16f4951ec6636a0f053df1585cdfe:4a98ff377fe44c28baeabd658328e7097cfad76a90e58f718039bd4a45fed1ac'
);
