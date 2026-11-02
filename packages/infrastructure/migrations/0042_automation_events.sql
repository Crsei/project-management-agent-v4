-- Scoped, creator-private integration credentials are encrypted by an explicitly configured deployment key.
CREATE TABLE automation_integration_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND config->>'projectId'=project_id),
  private_config text NOT NULL,
  has_credentials boolean NOT NULL,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN ('configured','verified','error','revoked')),
  verification jsonb NOT NULL DEFAULT '{"mcp":false,"nativeApi":false}'::jsonb CHECK (jsonb_typeof(verification)='object'),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,actor_id,id)
);
CREATE INDEX automation_integration_owner_idx ON automation_integration_connections(workspace_id,actor_id,project_id);
CREATE TABLE automation_event_endpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  definition_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND config->>'projectId'=project_id AND config->>'definitionId'=definition_id::text),
  private_secret text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,actor_id,id),
  FOREIGN KEY(workspace_id,actor_id,definition_id) REFERENCES automation_studio_definitions(workspace_id,actor_id,id)
);
CREATE INDEX automation_event_owner_idx ON automation_event_endpoints(workspace_id,actor_id,project_id);
CREATE TABLE automation_event_inbox (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES automation_event_endpoints(id),
  endpoint_revision integer NOT NULL CHECK (endpoint_revision > 0),
  external_event_id text NOT NULL,
  body_sha256 text NOT NULL CHECK (length(body_sha256)=64),
  body_replay boolean NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object' AND receipt->>'eventId'=id::text),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(endpoint_id,external_event_id)
);
CREATE UNIQUE INDEX automation_event_body_replay ON automation_event_inbox(endpoint_id,body_sha256) WHERE body_replay;
CREATE TABLE automation_integration_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  project_ids text[] NOT NULL,
  http_status integer NOT NULL CHECK (http_status BETWEEN 200 AND 599),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,request_id)
);
-- Dispatch intent commits before network. Never retry an indeterminate external write.
CREATE TABLE automation_integration_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  execution_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES automation_integration_connections(id),
  connection_revision integer NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('dispatching','completed','outcome_unknown')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(execution_id,id)
);
CREATE FUNCTION automation_integration_operation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status IN ('completed','outcome_unknown') THEN RAISE EXCEPTION 'Integration terminal operations are immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.workspace_id,NEW.actor_id,NEW.project_id,NEW.execution_id,NEW.connection_id,NEW.connection_revision,NEW.request_hash,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.actor_id,OLD.project_id,OLD.execution_id,OLD.connection_id,OLD.connection_revision,OLD.request_hash,OLD.created_at)
    THEN RAISE EXCEPTION 'Integration operation intent is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_integration_operation_frozen BEFORE UPDATE OR DELETE ON automation_integration_operations FOR EACH ROW EXECUTE FUNCTION automation_integration_operation_frozen();
CREATE TRIGGER automation_event_inbox_immutable BEFORE UPDATE OR DELETE ON automation_event_inbox FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TRIGGER automation_integration_receipts_immutable BEFORE UPDATE OR DELETE ON automation_integration_receipts FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();

-- Narrow native generation grants have explicit server-side revocation independent of the Agent process.
CREATE TABLE automation_integration_grants (
  generation_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);