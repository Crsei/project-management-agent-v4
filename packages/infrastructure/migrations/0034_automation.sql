-- Automation owns reports and scheduling only; Markdown task facts remain read-only.
CREATE TABLE automation_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND config->>'projectId'=project_id AND config->>'action'='report'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','paused')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_run_at timestamptz,
  next_due_at timestamptz,
  deleted_at timestamptz,
  UNIQUE(workspace_id,actor_id,id),
  CHECK (next_due_at IS NULL OR (status='enabled' AND deleted_at IS NULL AND config->'trigger'->>'kind'='daily'))
);
CREATE INDEX automation_rules_owner_idx ON automation_rules(workspace_id,actor_id,id) WHERE deleted_at IS NULL;
CREATE INDEX automation_rules_due_idx ON automation_rules(next_due_at,id) WHERE status='enabled' AND deleted_at IS NULL AND next_due_at IS NOT NULL;
CREATE TABLE automation_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  due_at timestamptz,
  budget_consumed boolean NOT NULL,
  started_at timestamptz NOT NULL,
  run jsonb NOT NULL CHECK (jsonb_typeof(run)='object' AND run->>'status' IN ('completed','skipped','failed') AND run->>'id'=id::text AND run->>'ruleId'=rule_id::text),
  FOREIGN KEY(workspace_id,actor_id,rule_id) REFERENCES automation_rules(workspace_id,actor_id,id),
  UNIQUE(rule_id,due_at),
  CHECK ((run->>'finishedAt')::timestamptz >= started_at)
);
CREATE INDEX automation_runs_owner_idx ON automation_runs(workspace_id,actor_id,id);
CREATE INDEX automation_runs_budget_idx ON automation_runs(rule_id,started_at) WHERE budget_consumed;
CREATE TABLE automation_receipts (
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
CREATE TABLE automation_scheduler_heartbeats (
  worker_id text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION automation_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Automation history and receipts are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER automation_runs_immutable BEFORE UPDATE OR DELETE ON automation_runs FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
CREATE TRIGGER automation_receipts_immutable BEFORE UPDATE OR DELETE ON automation_receipts FOR EACH ROW EXECUTE FUNCTION automation_immutable_history();
