-- Cloudflare D1 Migration 0001: Sessions and Conversation History Schema
-- Authoritative persistent storage for LBV Sales Engine sessions

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  auth_token TEXT NOT NULL,
  product_id TEXT NOT NULL,
  room_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'model')),
  text TEXT,
  tool_calls_json TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Indexes for ultra-fast lookup, authorization validation, and expiration cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_product ON sessions(product_id);
CREATE INDEX IF NOT EXISTS idx_sessions_auth_token ON sessions(auth_token);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_turns_session_index ON conversation_turns(session_id, turn_index);
