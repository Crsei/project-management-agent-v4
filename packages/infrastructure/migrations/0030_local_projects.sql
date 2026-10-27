-- This ledger coordinates recoverable disk/SQL work; Markdown remains the project authority.
CREATE TABLE local_project_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  default_parent text NOT NULL CHECK (length(default_parent) BETWEEN 1 AND 4096),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE local_project_operations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 512),
  operation text NOT NULL CHECK (operation IN ('initialize','migrate','relocate')),
  transport text NOT NULL CHECK (transport IN ('native','command')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  project_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','rejected')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,request_key),
  CHECK (operation='initialize' OR project_id IS NOT NULL)
);
CREATE FUNCTION pm_local_project_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.actor_id,NEW.request_key,NEW.operation,NEW.transport,NEW.request_hash,NEW.request,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.workspace_id,OLD.actor_id,OLD.request_key,OLD.operation,OLD.transport,OLD.request_hash,OLD.request,OLD.created_at)
  THEN RAISE EXCEPTION 'Local project operation identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id
  THEN RAISE EXCEPTION 'Reserved project identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER local_project_operation_identity BEFORE UPDATE ON local_project_operations FOR EACH ROW EXECUTE FUNCTION pm_local_project_operation_identity();
-- Worker has no reason to see host paths, pending initialization inputs, or mutate storage.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='project_management_worker') THEN
    REVOKE ALL ON local_project_settings,local_project_operations FROM project_management_worker;
  END IF;
END $$;
