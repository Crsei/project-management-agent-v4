CREATE TABLE agent_code_workspaces (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  project_key text NOT NULL CHECK (project_key='' OR project_key ~ '^PRJ-[0-9]+$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  revision integer NOT NULL CHECK (revision>0),
  primary_root_id text NOT NULL,
  roots jsonb NOT NULL CHECK (jsonb_typeof(roots)='array' AND jsonb_array_length(roots) BETWEEN 1 AND 32),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE agent_chat_scratch (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL CHECK (project_key='' OR project_key ~ '^PRJ-[0-9]+$'),
  actor_id uuid NOT NULL REFERENCES users(id),
  path text NOT NULL,
  directory_device text NOT NULL CHECK (directory_device ~ '^[0-9]+$'),
  directory_inode text NOT NULL CHECK (directory_inode ~ '^[0-9]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,project_key,actor_id)
);
