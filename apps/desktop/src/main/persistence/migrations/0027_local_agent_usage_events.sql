CREATE TABLE local_agent_usage_events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (
    action IN ('search', 'preview.read', 'original.read', 'edit', 'delete')
  ),
  resource_id    TEXT,
  occurred_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_local_agent_usage_window
  ON local_agent_usage_events(session_id, action, occurred_at_ms DESC);

