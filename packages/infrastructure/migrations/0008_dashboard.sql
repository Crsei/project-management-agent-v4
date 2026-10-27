-- PM-only dashboard records never replace authoritative Markdown entities.
CREATE TABLE dashboard_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,79}$'),
  owner_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(id),
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, owner_id) REFERENCES memberships(workspace_id, user_id)
);
CREATE INDEX dashboard_records_scope_kind_idx ON dashboard_records(workspace_id, kind, project_id, owner_id, id);
CREATE FUNCTION pm_guard_dashboard_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dashboard history is retained' USING ERRCODE='23514', CONSTRAINT='dashboard_history_retained';
  END IF;
  IF ROW(NEW.id, NEW.workspace_id, NEW.project_id, NEW.kind, NEW.owner_id, NEW.created_at, NEW.created_by)
    IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.project_id, OLD.kind, OLD.owner_id, OLD.created_at, OLD.created_by)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid dashboard identity or version update' USING ERRCODE='23514', CONSTRAINT='dashboard_identity_version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dashboard_record_history_guard BEFORE UPDATE OR DELETE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_dashboard_record();

-- Actor-scoped self data is accessible to restricted members without granting
-- workspace-wide reads. Project scopes still apply when the command references one.
ALTER TABLE command_receipts ADD COLUMN actor_scope integer NOT NULL DEFAULT 0 CHECK (actor_scope IN (0,1));
ALTER TABLE outbox ADD COLUMN audience_actor_id uuid REFERENCES users(id);
ALTER TABLE events ADD COLUMN audience_actor_id uuid REFERENCES users(id);
CREATE INDEX events_actor_scope_idx ON events(workspace_id, audience_actor_id, cursor);
