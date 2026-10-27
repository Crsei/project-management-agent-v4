-- Teams organize collaboration; no trigger writes membership or access grants.
CREATE UNIQUE INDEX project_team_assignment_unique ON dashboard_records(workspace_id, project_id)
  WHERE kind='project_team_assignment';
CREATE INDEX project_team_directory_idx ON dashboard_records(workspace_id, kind, created_at, id)
  WHERE kind='project_team';

CREATE FUNCTION pm_guard_project_directory_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reference text;
  team dashboard_records%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('project_team','project_team_assignment') THEN
    RETURN NEW;
  END IF;
  IF NEW.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'team data is not actor-owned' USING ERRCODE='23514', CONSTRAINT='project_team_scope';
  END IF;
  IF NEW.kind='project_team' THEN
    IF NEW.project_id IS NOT NULL OR NOT coalesce(
      jsonb_typeof(NEW.data->'name')='string' AND length(trim(NEW.data->>'name')) BETWEEN 1 AND 160
      AND jsonb_typeof(NEW.data->'memberIds')='array' AND jsonb_array_length(NEW.data->'memberIds') <= 1000
      AND (NEW.data->'archivedAt'='null'::jsonb OR jsonb_typeof(NEW.data->'archivedAt')='string')
      AND NEW.data - ARRAY['name','memberIds','archivedAt']::text[] = '{}'::jsonb, false) THEN
      RAISE EXCEPTION 'invalid team data' USING ERRCODE='23514', CONSTRAINT='project_team_data';
    END IF;
    IF TG_OP='UPDATE' AND OLD.data->>'archivedAt' IS NOT NULL THEN
      RAISE EXCEPTION 'archived teams are read only' USING ERRCODE='23514', CONSTRAINT='project_team_archived';
    END IF;
    IF NEW.data->>'archivedAt' IS NOT NULL THEN
      PERFORM (NEW.data->>'archivedAt')::timestamptz;
    END IF;
    IF (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(NEW.data->'memberIds')) THEN
      RAISE EXCEPTION 'duplicate team members' USING ERRCODE='23514', CONSTRAINT='project_team_member_unique';
    END IF;
    FOR reference IN SELECT jsonb_array_elements_text(NEW.data->'memberIds') LOOP
      IF reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'invalid team member identity' USING ERRCODE='23514', CONSTRAINT='project_team_member_identity';
      END IF;
      -- Existing roster entries may be revoked later. Rename/archive must still
      -- work; reads always intersect the roster with current membership.
      IF (TG_OP='INSERT' OR NEW.data->'memberIds' IS DISTINCT FROM OLD.data->'memberIds') AND NOT EXISTS (
        SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=NEW.workspace_id AND m.user_id=reference::uuid AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      ) THEN
        RAISE EXCEPTION 'team member requires active workspace membership' USING ERRCODE='23514', CONSTRAINT='project_team_member_active';
      END IF;
    END LOOP;
  ELSE
    IF NEW.project_id IS NULL OR NOT coalesce(jsonb_typeof(NEW.data->'teamIds')='array'
      AND jsonb_array_length(NEW.data->'teamIds') <= 100
      AND NEW.data - 'teamIds' = '{}'::jsonb, false) THEN
      RAISE EXCEPTION 'invalid project team assignment' USING ERRCODE='23514', CONSTRAINT='project_team_assignment_data';
    END IF;
    IF (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(NEW.data->'teamIds')) THEN
      RAISE EXCEPTION 'duplicate assigned teams' USING ERRCODE='23514', CONSTRAINT='project_team_assignment_unique_ids';
    END IF;
    FOR reference IN SELECT jsonb_array_elements_text(NEW.data->'teamIds') LOOP
      IF reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'invalid team identity' USING ERRCODE='23514', CONSTRAINT='project_team_assignment_identity';
      END IF;
      SELECT * INTO team FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND id=reference::uuid AND kind='project_team' AND project_id IS NULL AND owner_id IS NULL;
      IF team.id IS NULL OR team.data->>'archivedAt' IS NOT NULL THEN
        RAISE EXCEPTION 'assignment requires active same-workspace team' USING ERRCODE='23514', CONSTRAINT='project_team_assignment_reference';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_directory_guard BEFORE INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_project_directory_record();
