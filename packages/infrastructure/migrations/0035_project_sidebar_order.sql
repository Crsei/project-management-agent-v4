-- Actor-private workspace navigation, separate from favorites and Markdown project facts.
CREATE UNIQUE INDEX project_sidebar_order_actor_unique ON dashboard_records(workspace_id, owner_id)
  WHERE kind='project_sidebar_order';

CREATE FUNCTION pm_guard_project_sidebar_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
  project_ids text[] := ARRAY[]::text[];
BEGIN
  IF NEW.kind <> 'project_sidebar_order' THEN RETURN NEW; END IF;
  IF NEW.project_id IS NOT NULL OR NEW.owner_id IS NULL OR NEW.owner_id IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'sidebar order requires personal workspace scope' USING ERRCODE='23514', CONSTRAINT='project_sidebar_order_scope';
  END IF;
  IF NOT coalesce(jsonb_typeof(NEW.data->'projectIds')='array', false) OR NEW.data - 'projectIds' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'sidebar order requires project IDs' USING ERRCODE='23514', CONSTRAINT='project_sidebar_order_data';
  END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(NEW.data->'projectIds') LOOP
    IF jsonb_typeof(entry) <> 'string' OR length(entry #>> '{}') > 80 OR (entry #>> '{}') !~ '^[A-Z][A-Z0-9]*-[0-9]+$' THEN
      RAISE EXCEPTION 'invalid sidebar project ID' USING ERRCODE='23514', CONSTRAINT='project_sidebar_order_id';
    END IF;
    IF (entry #>> '{}')=ANY(project_ids) THEN
      RAISE EXCEPTION 'duplicate sidebar project ID' USING ERRCODE='23514', CONSTRAINT='project_sidebar_order_id';
    END IF;
    project_ids := array_append(project_ids, entry #>> '{}');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER project_sidebar_order_guard BEFORE INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_project_sidebar_order();
