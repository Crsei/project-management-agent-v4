-- Analysis history is immutable; user review state and original-request recovery are separate.
CREATE TABLE automation_pm_snapshots (
  execution_id uuid PRIMARY KEY REFERENCES automation_studio_executions(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), project_id text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE automation_pm_results (
  execution_id uuid PRIMARY KEY REFERENCES automation_pm_snapshots(execution_id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), project_id text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'), result_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE automation_pm_candidates (
  execution_id uuid NOT NULL REFERENCES automation_pm_results(execution_id), id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0), candidate jsonb NOT NULL CHECK(jsonb_typeof(candidate)='object'),
  active_request_id uuid, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(execution_id,id)
);
CREATE TABLE automation_pm_candidate_history (
  execution_id uuid NOT NULL, candidate_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  actor_id uuid NOT NULL REFERENCES users(id), request_id uuid, candidate jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(execution_id,candidate_id,revision),
  FOREIGN KEY(execution_id,candidate_id) REFERENCES automation_pm_candidates(execution_id,id)
);
CREATE TABLE automation_pm_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
  execution_id uuid NOT NULL REFERENCES automation_pm_results(execution_id), candidate_id text NOT NULL,
  request_hash text NOT NULL, operation text NOT NULL CHECK(operation IN ('edit','preview','apply','ignore')),
  input jsonb NOT NULL, http_status integer NOT NULL CHECK(http_status BETWEEN 200 AND 599), result jsonb NOT NULL,
  settled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TABLE automation_pm_apply_steps (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
  step_id text NOT NULL, operation_id uuid NOT NULL, tool text NOT NULL, input jsonb NOT NULL,
  result jsonb, error jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,request_id,step_id), UNIQUE(workspace_id,actor_id,operation_id),
  FOREIGN KEY(workspace_id,actor_id,request_id) REFERENCES automation_pm_receipts(workspace_id,actor_id,request_id)
);
CREATE TABLE automation_pm_signals (
  id bigserial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), project_id text NOT NULL,
  actor_id uuid REFERENCES users(id), source_key text NOT NULL, payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), dispatched_at timestamptz,
  definition_after text NOT NULL DEFAULT '',
  UNIQUE(workspace_id,source_key)
);
CREATE INDEX automation_pm_signals_pending ON automation_pm_signals(workspace_id,id) WHERE dispatched_at IS NULL;
CREATE INDEX automation_pm_outbox_cursor ON outbox(workspace_id,id);
CREATE TABLE automation_pm_signal_cursors (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), outbox_id bigint NOT NULL DEFAULT 0
);
CREATE TABLE automation_pm_visits (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), project_id text NOT NULL,
  last_visit_at timestamptz NOT NULL, request_id uuid NOT NULL, PRIMARY KEY(workspace_id,actor_id,project_id)
);
CREATE TRIGGER automation_pm_snapshots_immutable BEFORE UPDATE OR DELETE ON automation_pm_snapshots FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TRIGGER automation_pm_results_immutable BEFORE UPDATE OR DELETE ON automation_pm_results FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TRIGGER automation_pm_history_immutable BEFORE UPDATE OR DELETE ON automation_pm_candidate_history FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE FUNCTION automation_pm_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.settled OR (NEW.workspace_id,NEW.actor_id,NEW.request_id,NEW.execution_id,NEW.candidate_id,NEW.request_hash,NEW.operation,NEW.input,NEW.created_at)
    IS DISTINCT FROM (OLD.workspace_id,OLD.actor_id,OLD.request_id,OLD.execution_id,OLD.candidate_id,OLD.request_hash,OLD.operation,OLD.input,OLD.created_at)
    THEN RAISE EXCEPTION 'PM automation original request receipts are immutable once settled' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_pm_receipt_frozen BEFORE UPDATE OR DELETE ON automation_pm_receipts FOR EACH ROW EXECUTE FUNCTION automation_pm_receipt_guard();
CREATE FUNCTION automation_pm_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.result IS NOT NULL OR OLD.error IS NOT NULL OR
    (NEW.workspace_id,NEW.actor_id,NEW.request_id,NEW.step_id,NEW.operation_id,NEW.tool,NEW.input,NEW.created_at)
    IS DISTINCT FROM (OLD.workspace_id,OLD.actor_id,OLD.request_id,OLD.step_id,OLD.operation_id,OLD.tool,OLD.input,OLD.created_at)
    THEN RAISE EXCEPTION 'PM automation operation identity and confirmed outcomes are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_pm_step_frozen BEFORE UPDATE OR DELETE ON automation_pm_apply_steps FOR EACH ROW EXECUTE FUNCTION automation_pm_step_guard();
CREATE FUNCTION automation_pm_signal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.workspace_id,NEW.project_id,NEW.actor_id,NEW.source_key,NEW.payload,NEW.recorded_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.actor_id,OLD.source_key,OLD.payload,OLD.recorded_at)
    OR NEW.definition_after < OLD.definition_after
    OR OLD.dispatched_at IS NOT NULL AND NEW IS DISTINCT FROM OLD
    THEN RAISE EXCEPTION 'PM automation signal source evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_pm_signal_frozen BEFORE UPDATE OR DELETE ON automation_pm_signals FOR EACH ROW EXECUTE FUNCTION automation_pm_signal_guard();
CREATE INDEX automation_pm_apply_result_command ON automation_pm_apply_steps(workspace_id,(result#>>'{receipt,commandId}')) WHERE result IS NOT NULL;
CREATE INDEX automation_pm_apply_result_target ON automation_pm_apply_steps(workspace_id,(result#>>'{receipt,targetId}'),(result#>>'{receipt,revision}')) WHERE result IS NOT NULL;
