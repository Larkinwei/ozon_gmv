CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  title TEXT NOT NULL,
  product_context_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_conversations_updated_idx
  ON ai_conversations (created_by, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json TEXT NOT NULL,
  run_id TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx
  ON ai_messages (conversation_id, created_at_ms ASC);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  model_alias TEXT NOT NULL,
  actual_model TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_hash TEXT NOT NULL,
  output_json TEXT,
  usage_json TEXT,
  request_id TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_runs_created_idx
  ON ai_runs (created_at_ms DESC);
