-- Execution-directory preferences only; Markdown remains project/task authority.
-- Empty project_key represents workspace scope. Core project IDs are not SQL entities.
CREATE TABLE agent_file_areas (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL DEFAULT '',
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 4096 AND left(path, 1) = '/'),
  directory_device text NOT NULL CHECK (directory_device ~ '^[0-9]+$'),
  directory_inode text NOT NULL CHECK (directory_inode ~ '^[0-9]+$'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_key),
  CHECK (project_key = '' OR project_key ~ '^PRJ-[0-9]+$')
);
