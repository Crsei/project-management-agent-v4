-- Discard the retired PM-only conversation history, not business receipts/audit.
DROP TABLE agent_chat_tool_calls;
DROP TABLE agent_chat_messages;
DROP TABLE agent_chat_threads;

-- Chat correlation IDs are opaque and deliberately have no PM chat foreign keys.
CREATE TABLE pm_agent_tool_operations (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  name text NOT NULL,
  thread_id text NOT NULL,
  message_id text NOT NULL,
  generation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX pm_agent_tool_operations_owner_idx ON pm_agent_tool_operations(workspace_id, actor_id, created_at);
