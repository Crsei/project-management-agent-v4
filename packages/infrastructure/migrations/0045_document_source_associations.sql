-- Association-set revisions are independent from immutable source identities.
-- Retain cleared/removed sources and original operation requests, hashes and receipts.
CREATE TABLE document_source_scopes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL DEFAULT '' CHECK (project_key='' OR project_key ~ '^PRJ-[0-9]+$'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,project_key)
);
INSERT INTO document_source_scopes(workspace_id,project_key,revision,updated_by,updated_at)
  SELECT workspace_id,project_key,revision,updated_by,updated_at FROM document_sources;

ALTER TABLE document_sources ADD COLUMN source_id text;
UPDATE document_sources SET source_id=CASE WHEN project_key='' THEN 'workspace' ELSE project_key END;
ALTER TABLE document_sources ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE document_sources ADD CONSTRAINT document_sources_source_id_check CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id ~ '^[A-Za-z0-9_-]+$');
ALTER TABLE document_sources ADD COLUMN removed_at timestamptz;
UPDATE document_sources SET removed_at=updated_at WHERE path IS NULL;
ALTER TABLE document_sources DROP CONSTRAINT document_sources_pkey;
ALTER TABLE document_sources ADD PRIMARY KEY (workspace_id,source_id);
ALTER TABLE document_sources ADD CONSTRAINT document_sources_active_path_check CHECK (removed_at IS NOT NULL OR path IS NOT NULL);
CREATE UNIQUE INDEX document_sources_active_scope_path ON document_sources(workspace_id,project_key,path) WHERE removed_at IS NULL;

-- Capture authorization as data before converting the old public-source key.
ALTER TABLE document_source_operations ADD COLUMN source_project_key text;
UPDATE document_source_operations SET source_project_key=source_key;
ALTER TABLE document_source_operations ALTER COLUMN source_project_key SET NOT NULL;
ALTER TABLE document_source_operations ADD CONSTRAINT document_source_operations_project_key_check CHECK (source_project_key='' OR source_project_key ~ '^PRJ-[0-9]+$');
ALTER TABLE document_source_operations DROP CONSTRAINT document_source_operations_source_key_check;
ALTER TABLE document_source_operations RENAME COLUMN source_key TO source_id;
UPDATE document_source_operations SET source_id='workspace' WHERE source_id='';
ALTER TABLE document_source_operations ADD CONSTRAINT document_source_operations_source_id_check CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id ~ '^[A-Za-z0-9_-]+$');
