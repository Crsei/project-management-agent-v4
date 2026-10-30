-- External read-only Markdown roots, independent of Agent execution directories.
-- Clearing a root keeps its row and CAS revision. The normal stopped SQL dump
-- includes this configuration; external source bytes are never copied into PM.
CREATE TABLE document_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL DEFAULT '',
  path text,
  directory_device text,
  directory_inode text,
  revision integer NOT NULL CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_key),
  CHECK (project_key = '' OR project_key ~ '^PRJ-[0-9]+$'),
  CHECK ((path IS NULL AND directory_device IS NULL AND directory_inode IS NULL) OR
    (path IS NOT NULL AND directory_device IS NOT NULL AND directory_inode IS NOT NULL AND
     length(path) BETWEEN 1 AND 4096 AND left(path,1) = '/' AND
     directory_device ~ '^[0-9]+$' AND directory_inode ~ '^[0-9]+$'))
);
