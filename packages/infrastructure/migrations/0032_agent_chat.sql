-- Private agent chat. These tables are not PM core entities and never change
-- project or work-item facts. Each thread is owned by one workspace member.
CREATE TABLE agent_chat_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_chat_threads_owner_idx ON agent_chat_threads(workspace_id, actor_id, updated_at DESC, id DESC);

CREATE TABLE agent_chat_messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL CHECK (char_length(content) <= 200000),
  status text NOT NULL CHECK (status IN ('complete','streaming','cancelled','error','interrupted')),
  error_code text,
  model text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((role = 'user' AND status = 'complete') OR role = 'assistant'),
  CHECK (status <> 'error' OR error_code IS NOT NULL)
);
CREATE INDEX agent_chat_messages_thread_idx ON agent_chat_messages(thread_id, seq);
-- One in-flight model reply per thread. A stale row is explicitly interrupted
-- or cancelled; it never silently allows a second concurrent generation.
CREATE UNIQUE INDEX agent_chat_messages_one_streaming_idx ON agent_chat_messages(thread_id) WHERE status = 'streaming';
