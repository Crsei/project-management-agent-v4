-- Definitions remain PM-owned; Git/import never insert into execution history.
CREATE TABLE automation_transfer_imports (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 project_id text NOT NULL, request_hash text NOT NULL, config jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')), result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TABLE automation_transfer_bundles (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id),
 project_id text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL, sha256 text NOT NULL, files jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(workspace_id,actor_id,request_id)
);
CREATE TRIGGER automation_transfer_bundles_immutable BEFORE UPDATE OR DELETE ON automation_transfer_bundles FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TABLE automation_git_configs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id),
 project_id text NOT NULL, revision integer NOT NULL DEFAULT 1, config jsonb NOT NULL, token_sealed text, encryption_key_sealed text,
 last_commit text, last_synced_at timestamptz, next_due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,actor_id,project_id)
);
CREATE TABLE automation_git_operations (
 id uuid PRIMARY KEY, config_id uuid NOT NULL REFERENCES automation_git_configs(id), config_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','outcome_unknown')),
 remote_commit text, prepared_commit text, error text, started_at timestamptz, finished_at timestamptz, checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX automation_git_one_active ON automation_git_operations(config_id) WHERE status IN ('pending','running','outcome_unknown');
CREATE INDEX automation_git_due ON automation_git_configs(next_due_at) WHERE next_due_at IS NOT NULL;
CREATE TABLE automation_git_mappings (
 config_id uuid NOT NULL REFERENCES automation_git_configs(id), path text NOT NULL, definition_id uuid NOT NULL,
 config_hash text NOT NULL, remote_hash text NOT NULL, PRIMARY KEY(config_id,path), UNIQUE(config_id,definition_id)
);
CREATE TABLE automation_git_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 project_id text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TRIGGER automation_git_receipts_immutable BEFORE UPDATE OR DELETE ON automation_git_receipts FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TABLE automation_git_sync_snapshots (
 operation_id uuid NOT NULL REFERENCES automation_git_operations(id), path text NOT NULL, definition_id uuid NOT NULL,
 config_hash text NOT NULL, remote_hash text NOT NULL, PRIMARY KEY(operation_id,path)
);
CREATE TRIGGER automation_git_snapshots_immutable BEFORE UPDATE OR DELETE ON automation_git_sync_snapshots FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE FUNCTION automation_transfer_import_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'pending' THEN RAISE EXCEPTION 'Import receipts are immutable after completion' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status'-'result') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'result') THEN RAISE EXCEPTION 'Import identity and configuration are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_transfer_import_freeze BEFORE UPDATE OR DELETE ON automation_transfer_imports FOR EACH ROW EXECUTE FUNCTION automation_transfer_import_transition();
CREATE FUNCTION automation_git_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'Finished Git history is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.id<>OLD.id OR NEW.config_id<>OLD.config_id OR NEW.config_revision<>OLD.config_revision OR NEW.created_at<>OLD.created_at OR (OLD.prepared_commit IS NOT NULL AND NEW.prepared_commit IS DISTINCT FROM OLD.prepared_commit) THEN RAISE EXCEPTION 'Git operation identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_git_operation_freeze BEFORE UPDATE OR DELETE ON automation_git_operations FOR EACH ROW EXECUTE FUNCTION automation_git_operation_transition();
