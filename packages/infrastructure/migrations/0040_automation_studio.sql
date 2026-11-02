-- Execution definitions are distinct from immutable legacy automation reports.
CREATE TABLE automation_studio_definitions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND config->>'projectId'=project_id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','paused')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_run_at timestamptz, next_due_at timestamptz, deleted_at timestamptz,
  UNIQUE(workspace_id,actor_id,id),
  CHECK (next_due_at IS NULL OR (status='enabled' AND deleted_at IS NULL))
);
CREATE INDEX automation_studio_definitions_owner ON automation_studio_definitions(workspace_id,actor_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX automation_studio_definitions_due ON automation_studio_definitions(next_due_at,id) WHERE status='enabled' AND deleted_at IS NULL;
CREATE TABLE automation_studio_executions (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, actor_id uuid NOT NULL, definition_id uuid NOT NULL,
  project_id text NOT NULL, definition_revision integer NOT NULL CHECK(definition_revision>0),
  config_snapshot jsonb NOT NULL CHECK(config_snapshot->>'projectId'=project_id),
  request_id uuid NOT NULL, trigger text NOT NULL CHECK(trigger IN ('manual','scheduled','event','test')),
  payload jsonb, source_key text, due_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','skipped','cancel_requested','cancelled','outcome_unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz, finished_at timestamptz,
  dispatched_at timestamptz, budget_consumed boolean NOT NULL DEFAULT false,
  external_execution_id text, thread_id text, summary text NOT NULL DEFAULT '', error text,
  lease_token uuid, lease_until timestamptz, next_query_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,actor_id,definition_id) REFERENCES automation_studio_definitions(workspace_id,actor_id,id),
  UNIQUE(definition_id,source_key), UNIQUE(workspace_id,actor_id,request_id),
  CHECK((status IN ('completed','failed','skipped','cancelled'))=(finished_at IS NOT NULL)),
  CHECK(finished_at IS NULL OR finished_at>=created_at)
);
CREATE INDEX automation_studio_executions_owner ON automation_studio_executions(workspace_id,actor_id,created_at DESC,id DESC);
CREATE INDEX automation_studio_executions_queue ON automation_studio_executions(next_query_at,id) WHERE finished_at IS NULL;
CREATE INDEX automation_studio_executions_budget ON automation_studio_executions(definition_id,started_at) WHERE budget_consumed;
CREATE TABLE automation_studio_execution_events (
  execution_id uuid NOT NULL REFERENCES automation_studio_executions(id), sequence bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), kind text NOT NULL CHECK(kind IN ('queued','dispatch','status','log','cancel','error')),
  message text NOT NULL, stream text CHECK(stream IN ('stdout','stderr','system')), external_id text,
  PRIMARY KEY(execution_id,sequence), UNIQUE(execution_id,external_id)
);
CREATE TABLE automation_studio_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
  request_hash text NOT NULL, project_ids text[] NOT NULL, http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TABLE automation_studio_heartbeats(worker_id text PRIMARY KEY,heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION automation_studio_freeze_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.finished_at IS NOT NULL THEN RAISE EXCEPTION 'Finished automation executions are immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.workspace_id,NEW.actor_id,NEW.definition_id,NEW.project_id,NEW.definition_revision,NEW.config_snapshot,NEW.request_id,NEW.trigger,NEW.payload,NEW.source_key,NEW.due_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.actor_id,OLD.definition_id,OLD.project_id,OLD.definition_revision,OLD.config_snapshot,OLD.request_id,OLD.trigger,OLD.payload,OLD.source_key,OLD.due_at,OLD.created_at)
    THEN RAISE EXCEPTION 'Automation execution intent is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_studio_execution_frozen BEFORE UPDATE OR DELETE ON automation_studio_executions FOR EACH ROW EXECUTE FUNCTION automation_studio_freeze_execution();
CREATE TRIGGER automation_studio_receipts_immutable BEFORE UPDATE OR DELETE ON automation_studio_receipts FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TRIGGER automation_studio_events_immutable BEFORE UPDATE OR DELETE ON automation_studio_execution_events FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE FUNCTION automation_studio_event_before_finish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM automation_studio_executions WHERE id=NEW.execution_id AND finished_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Finished automation event history is frozen' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_studio_events_frozen BEFORE INSERT ON automation_studio_execution_events FOR EACH ROW EXECUTE FUNCTION automation_studio_event_before_finish();
