-- A capacity is an explicit workspace/person fact; no task data is copied to SQL.
CREATE UNIQUE INDEX member_capacity_workspace_person_unique ON dashboard_records(workspace_id, (data->>'userId'))
  WHERE kind='member_capacity';

CREATE FUNCTION pm_guard_member_capacity_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'member_capacity' THEN
    RETURN NEW;
  END IF;
  IF NEW.project_id IS NOT NULL OR NEW.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'member capacity requires workspace scope' USING ERRCODE='23514', CONSTRAINT='member_capacity_scope';
  END IF;
  IF NOT coalesce(jsonb_typeof(NEW.data->'userId')='string'
    AND NEW.data->>'userId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NEW.data ? 'capacityPoints'
    AND NEW.data - ARRAY['userId','capacityPoints']::text[] = '{}'::jsonb, false) THEN
    RAISE EXCEPTION 'invalid member capacity data' USING ERRCODE='23514', CONSTRAINT='member_capacity_data';
  END IF;
  IF NEW.data->'capacityPoints' <> 'null'::jsonb THEN
    IF jsonb_typeof(NEW.data->'capacityPoints') <> 'number' THEN
      RAISE EXCEPTION 'capacity must be numeric or null' USING ERRCODE='23514', CONSTRAINT='member_capacity_points';
    END IF;
    IF (NEW.data->>'capacityPoints')::numeric < 0 OR (NEW.data->>'capacityPoints')::numeric > 1000000 THEN
      RAISE EXCEPTION 'capacity must be between zero and one million points' USING ERRCODE='23514', CONSTRAINT='member_capacity_points';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.data->>'userId' IS DISTINCT FROM OLD.data->>'userId' THEN
    RAISE EXCEPTION 'capacity person is immutable' USING ERRCODE='23514', CONSTRAINT='member_capacity_identity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=NEW.workspace_id AND m.user_id=(NEW.data->>'userId')::uuid
      AND m.revoked_at IS NULL AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'capacity target requires active workspace membership' USING ERRCODE='23514', CONSTRAINT='member_capacity_member_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_capacity_guard BEFORE INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_member_capacity_record();
