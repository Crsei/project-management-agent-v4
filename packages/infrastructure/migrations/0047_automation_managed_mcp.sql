-- No network, native target writes or credential decryption during schema upgrade.
-- Existing MCP material is quarantined for the explicit offline migration command only.
CREATE TABLE automation_integration_migration_sources (
  connection_id uuid PRIMARY KEY REFERENCES automation_integration_connections(id),
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  project_id text NOT NULL,
  source_revision integer NOT NULL,
  source_config jsonb NOT NULL,
  sealed_headers text NOT NULL,
  source_status text NOT NULL,
  source_verification jsonb NOT NULL,
  source_last_error text,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE automation_integration_definition_migrations (
  connection_id uuid PRIMARY KEY REFERENCES automation_integration_connections(id),
  source_digest text NOT NULL CHECK (length(source_digest)=64),
  context_id text NOT NULL,
  server_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared','imported','cutover')),
  config_fingerprint text,
  target_revision integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(context_id,server_id)
);
INSERT INTO automation_integration_migration_sources(connection_id,workspace_id,actor_id,project_id,source_revision,source_config,sealed_headers,source_status,source_verification,source_last_error)
SELECT id,workspace_id,actor_id,project_id,revision,config,private_config,status,verification,last_error
FROM automation_integration_connections
WHERE status<>'revoked' AND jsonb_array_length(config->'readTools')+jsonb_array_length(config->'writeTools')>0;
ALTER TABLE automation_integration_connections ADD COLUMN native_private_config text NOT NULL DEFAULT '';
ALTER TABLE automation_integration_connections ADD COLUMN mcp_config_fingerprint text;
UPDATE automation_integration_connections SET
  native_private_config=CASE WHEN config ? 'nativeApi' THEN private_config ELSE '' END,
  has_credentials=CASE WHEN config ? 'nativeApi' THEN has_credentials ELSE false END,
  config=config-'endpoint',
  status=CASE WHEN status='revoked' THEN status WHEN jsonb_array_length(config->'readTools')+jsonb_array_length(config->'writeTools')>0 THEN 'configured' ELSE status END,
  verification=CASE WHEN jsonb_array_length(config->'readTools')+jsonb_array_length(config->'writeTools')>0 THEN jsonb_set(verification,'{mcp}','false') ELSE verification END,
  last_error=CASE WHEN status<>'revoked' AND jsonb_array_length(config->'readTools')+jsonb_array_length(config->'writeTools')>0 THEN 'integration_definition_migration_required' ELSE last_error END;
ALTER TABLE automation_integration_connections DROP COLUMN private_config;
ALTER TABLE automation_integration_connections ADD CONSTRAINT automation_integration_no_inline_mcp CHECK (NOT config ? 'endpoint' AND NOT config ? 'privateHeaders');
CREATE INDEX automation_integration_definition_ref_idx ON automation_integration_connections((config->'mcpDefinition'->>'contextId'),(config->'mcpDefinition'->>'serverId')) WHERE status<>'revoked';
-- Cross-store deletion exclusion. Contains no definition payload or credentials.
CREATE TABLE automation_integration_definition_deletions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  context_id text NOT NULL,
  server_id text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,project_id,context_id,server_id)
);
