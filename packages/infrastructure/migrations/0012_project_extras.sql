-- PM annotations only; authoritative projects remain in the Markdown core.
CREATE UNIQUE INDEX project_favorite_actor_unique ON dashboard_records(workspace_id, owner_id, project_id)
  WHERE kind='project_favorite';
CREATE UNIQUE INDEX project_extras_head_unique ON dashboard_records(workspace_id, project_id, kind)
  WHERE kind IN ('project_cover','project_scope');

CREATE FUNCTION pm_guard_project_extras() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry jsonb;
  item_ids text[] := ARRAY[]::text[];
  reference entities%ROWTYPE;
  artifact entities%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('project_favorite','project_cover','project_scope') THEN RETURN NEW; END IF;
  IF NEW.project_id IS NULL THEN
    RAISE EXCEPTION 'project extras require a project' USING ERRCODE='23514', CONSTRAINT='project_extras_project_scope';
  END IF;
  IF NEW.kind='project_favorite' THEN
    IF NEW.owner_id IS NULL OR (TG_OP='INSERT' AND NEW.owner_id IS DISTINCT FROM NEW.created_by)
      OR NOT coalesce(jsonb_typeof(NEW.data->'favorite')='boolean', false) OR NEW.data - 'favorite' <> '{}'::jsonb THEN
      RAISE EXCEPTION 'favorite requires actor ownership and explicit boolean' USING ERRCODE='23514', CONSTRAINT='project_favorite_data';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'cover and scope require public project scope' USING ERRCODE='23514', CONSTRAINT='project_extras_public_scope';
  END IF;
  IF NEW.kind='project_cover' THEN
    IF NOT (NEW.data ? 'artifactVersionId' AND NEW.data ? 'mediaType') OR NEW.data - ARRAY['artifactVersionId','mediaType'] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'invalid project cover association' USING ERRCODE='23514', CONSTRAINT='project_cover_data';
    END IF;
    IF NEW.data->'artifactVersionId'='null'::jsonb AND NEW.data->'mediaType'='null'::jsonb THEN RETURN NEW; END IF;
    IF NOT coalesce(jsonb_typeof(NEW.data->'artifactVersionId')='string'
      AND NEW.data->>'artifactVersionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND NEW.data->>'mediaType' IN ('image/png','image/jpeg','image/gif','image/webp'), false) THEN
      RAISE EXCEPTION 'safe raster version required' USING ERRCODE='23514', CONSTRAINT='project_cover_media_type';
    END IF;
    SELECT * INTO reference FROM entities WHERE workspace_id=NEW.workspace_id AND id=(NEW.data->>'artifactVersionId')::uuid AND kind='artifact_version';
    IF reference.id IS NULL OR reference.project_id IS DISTINCT FROM NEW.project_id
      OR reference.data->>'mediaType' IS DISTINCT FROM NEW.data->>'mediaType' THEN
      RAISE EXCEPTION 'cover version must belong to the same project' USING ERRCODE='23514', CONSTRAINT='project_cover_version_scope';
    END IF;
    SELECT * INTO artifact FROM entities WHERE workspace_id=NEW.workspace_id AND id=(reference.data->>'artifactId')::uuid AND kind='artifact';
    IF artifact.id IS NULL OR artifact.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'cover requires registered same-project artifact' USING ERRCODE='23514', CONSTRAINT='project_cover_artifact_scope';
    END IF;
  END IF;
  IF NEW.kind='project_scope' THEN
    IF NOT coalesce(jsonb_typeof(NEW.data->'items')='array', false) OR NEW.data - 'items' <> '{}'::jsonb THEN
      RAISE EXCEPTION 'scope requires checklist items' USING ERRCODE='23514', CONSTRAINT='project_scope_items';
    END IF;
    IF jsonb_array_length(NEW.data->'items') > 200 THEN
      RAISE EXCEPTION 'scope has too many items' USING ERRCODE='23514', CONSTRAINT='project_scope_items';
    END IF;
    FOR entry IN SELECT * FROM jsonb_array_elements(NEW.data->'items') LOOP
      IF NOT coalesce(jsonb_typeof(entry)='object' AND jsonb_typeof(entry->'id')='string'
        AND entry->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(entry->'text')='string' AND length(trim(entry->>'text')) BETWEEN 1 AND 2000
        AND jsonb_typeof(entry->'completed')='boolean', false) OR entry - ARRAY['id','text','completed'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid scope checklist item' USING ERRCODE='23514', CONSTRAINT='project_scope_item_data';
      END IF;
      IF entry->>'id'=ANY(item_ids) THEN
        RAISE EXCEPTION 'duplicate scope checklist item ID' USING ERRCODE='23514', CONSTRAINT='project_scope_item_identity';
      END IF;
      item_ids := array_append(item_ids, entry->>'id');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_extras_guard BEFORE INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_project_extras();
