ALTER TABLE agent_file_areas ADD COLUMN source text NOT NULL DEFAULT 'explicit'
  CONSTRAINT agent_file_areas_source_check CHECK (source IN ('explicit','default'));

CREATE TABLE agent_storage_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  default_root text NOT NULL CONSTRAINT agent_storage_settings_root_check CHECK (length(default_root) BETWEEN 1 AND 4096 AND left(default_root,1)='/'),
  revision integer NOT NULL CONSTRAINT agent_storage_settings_revision_check CHECK (revision>0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
