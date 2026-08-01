-- MCP-created Library/Sizzle chats are private to the authenticated local
-- client. NULL means a human/PwrSnap-owned thread and is never selected by an
-- external client's reuse policy.
ALTER TABLE chat_threads ADD COLUMN owner_client_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_threads_owner_anchor
  ON chat_threads (owner_client_id, anchor_capture_id, modified_at DESC);
