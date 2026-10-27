-- Chat-scoped authorization and tool receipts, not a business execution system.
ALTER TABLE agent_chat_threads
  ADD COLUMN access_revision integer NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  ADD COLUMN access_grant_id uuid,
  ADD COLUMN access_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN access_scope jsonb NOT NULL DEFAULT '{"kind":"projects","projectIds":[]}'::jsonb,
  ADD COLUMN access_expires_at timestamptz,
  ADD COLUMN access_revoked_at timestamptz,
  ADD COLUMN access_tools_version integer NOT NULL DEFAULT 1,
  ADD COLUMN tool_support_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN tool_support_provider text;
ALTER TABLE agent_chat_messages ADD COLUMN context_sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_sources)='array');
CREATE TABLE agent_chat_tool_calls (
  operation_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES agent_chat_messages(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) BETWEEN 1 AND 200),
  tool_name text NOT NULL,
  input_hash text NOT NULL,
  is_write boolean NOT NULL,
  grant_revision integer NOT NULL,
  scope jsonb NOT NULL,
  call jsonb NOT NULL CHECK (jsonb_typeof(call)='object' AND call->>'status' IN ('running','succeeded','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(message_id,tool_call_id)
);
CREATE UNIQUE INDEX agent_chat_write_request_once_idx ON agent_chat_tool_calls(message_id,tool_name,input_hash) WHERE is_write;
CREATE INDEX agent_chat_tool_calls_thread_idx ON agent_chat_tool_calls(thread_id,created_at,operation_id);
