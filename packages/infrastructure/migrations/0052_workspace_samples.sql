CREATE TABLE workspace_sample_initializations (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  request_key text,
  workspace_name text NOT NULL,
  template jsonb NOT NULL,
  directory jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  project_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((status = 'ready') = (project_id IS NOT NULL AND completed_at IS NOT NULL)),
  UNIQUE (actor_id, request_key)
);
