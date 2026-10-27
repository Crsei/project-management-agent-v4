-- Personal state is not an event archive. Retention of the real event owns its lifetime.
ALTER TABLE events ADD CONSTRAINT events_workspace_event_unique UNIQUE(workspace_id,event_id);

CREATE TABLE activity_states (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  event_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 2),
  read_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,actor_id,event_id),
  FOREIGN KEY(workspace_id,event_id) REFERENCES events(workspace_id,event_id) ON DELETE CASCADE
);
CREATE INDEX activity_states_event_idx ON activity_states(workspace_id,event_id);

-- No event envelope, title, project name or payload is copied into this table.
CREATE FUNCTION pm_guard_activity_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.actor_id,NEW.event_id) IS DISTINCT FROM (OLD.workspace_id,OLD.actor_id,OLD.event_id) THEN
      RAISE EXCEPTION 'activity state identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.version <> OLD.version+1 THEN
      RAISE EXCEPTION 'activity state requires next version' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.version <> 2 THEN
    RAISE EXCEPTION 'initial persisted activity state must be version two' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activity_state_guard BEFORE INSERT OR UPDATE ON activity_states FOR EACH ROW EXECUTE FUNCTION pm_guard_activity_state();
