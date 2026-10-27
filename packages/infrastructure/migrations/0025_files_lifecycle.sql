-- No blob deletion, history rewrite or inferred provenance. Fail with precise IDs
-- before changing the read model when pre-existing attachment data is corrupt.
DO $$
DECLARE a entities%ROWTYPE; v entities%ROWTYPE; u entities%ROWTYPE; ref text; repaired_title text;
BEGIN
  FOR v IN SELECT * FROM entities WHERE kind='artifact_version' LOOP
    SELECT * INTO a FROM entities WHERE workspace_id=v.workspace_id AND id::text=v.data->>'artifactId' AND kind='artifact' AND project_id=v.project_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'files migration: orphan/cross-scope version %',v.id; END IF;
    IF jsonb_typeof(v.data->'size') IS DISTINCT FROM 'number' OR coalesce(v.data->>'size','') !~ '^(0|[1-9][0-9]{0,6})$'
      THEN RAISE EXCEPTION 'files migration: invalid version size %',v.id; END IF;
    SELECT * INTO u FROM entities WHERE workspace_id=v.workspace_id AND id::text=v.data->>'uploadId' AND kind='upload' AND project_id=v.project_id;
    IF NOT FOUND OR u.data->>'consumedByArtifactVersionId' IS DISTINCT FROM v.id::text OR u.data->>'consumedAt' IS NULL
      OR v.data->>'sha256' IS NULL OR v.data->>'sha256' !~ '^[a-f0-9]{64}$'
      OR v.data->>'contentDigest' IS DISTINCT FROM v.data->>'sha256'
      OR v.data->'size' IS DISTINCT FROM u.data->'size'
      OR (v.data->>'size')::bigint NOT BETWEEN 0 AND 8388608
      OR v.data->>'objectKey' IS DISTINCT FROM u.data->>'objectKey' OR v.data->>'sha256' IS DISTINCT FROM u.data->>'sha256'
      OR v.data->>'mediaType' IS DISTINCT FROM u.data->>'mediaType' OR v.data->>'fileName' IS DISTINCT FROM u.data->>'fileName'
      OR jsonb_typeof(v.data->'fileName') IS DISTINCT FROM 'string' OR length(v.data->>'fileName') NOT BETWEEN 1 AND 255
      OR jsonb_typeof(v.data->'mediaType') IS DISTINCT FROM 'string'
      THEN RAISE EXCEPTION 'files migration: invalid version/upload metadata %',v.id; END IF;
  END LOOP;
  FOR a IN SELECT * FROM entities WHERE kind='artifact' LOOP
    IF jsonb_typeof(a.data->'versionRefs') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'files migration: invalid versionRefs %',a.id; END IF;
    IF jsonb_array_length(a.data->'versionRefs')=0 OR
      (SELECT count(*) FROM jsonb_array_elements_text(a.data->'versionRefs'))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(a.data->'versionRefs'))
      THEN RAISE EXCEPTION 'files migration: duplicate/empty versionRefs %',a.id; END IF;
    FOR ref IN SELECT jsonb_array_elements_text(a.data->'versionRefs') LOOP
      IF NOT EXISTS(SELECT 1 FROM entities WHERE workspace_id=a.workspace_id AND id::text=ref AND kind='artifact_version' AND project_id=a.project_id AND data->>'artifactId'=a.id::text)
        THEN RAISE EXCEPTION 'files migration: invalid version reference % on %',ref,a.id; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM entities WHERE workspace_id=a.workspace_id AND kind='artifact_version' AND data->>'artifactId'=a.id::text AND NOT (a.data->'versionRefs' ? id::text))
      THEN RAISE EXCEPTION 'files migration: unlisted version on %',a.id; END IF;
    SELECT * INTO v FROM entities WHERE workspace_id=a.workspace_id AND id::text=a.data->>'latestVersionId' AND kind='artifact_version' AND project_id=a.project_id AND data->>'artifactId'=a.id::text;
    IF NOT FOUND OR NOT (a.data->'versionRefs' ? v.id::text) THEN RAISE EXCEPTION 'files migration: invalid latestVersionId %',a.id; END IF;
    repaired_title := a.data->>'title';
    IF NOT (a.data ? 'title') OR a.data->'title'='null'::jsonb OR jsonb_typeof(a.data->'title')='string' AND btrim(repaired_title)='' THEN repaired_title := v.data->>'fileName';
    ELSIF jsonb_typeof(a.data->'title') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'files migration: invalid title type %',a.id; END IF;
    IF length(btrim(repaired_title)) NOT BETWEEN 1 AND 20000 OR repaired_title IS NULL THEN RAISE EXCEPTION 'files migration: invalid title %',a.id; END IF;
    IF NOT (a.data ?& ARRAY['hiddenAt','hiddenBy']) OR a.data->>'title' IS DISTINCT FROM repaired_title THEN
      UPDATE entities SET data=data || jsonb_build_object('title',repaired_title,'hiddenAt',null,'hiddenBy',null),version=version+1,updated_at=now() WHERE id=a.id;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION pm_artifact_metadata_valid(data jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(data->'title') IS DISTINCT FROM 'string' OR length(btrim(data->>'title')) NOT BETWEEN 1 AND 20000
    OR NOT (data ?& ARRAY['hiddenAt','hiddenBy']) THEN RETURN false; END IF;
  IF data->'hiddenAt'='null'::jsonb AND data->'hiddenBy'='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(data->'hiddenAt') IS DISTINCT FROM 'string' OR jsonb_typeof(data->'hiddenBy') IS DISTINCT FROM 'string'
    OR data->>'hiddenBy' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    OR data->>'hiddenAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN RETURN false; END IF;
  PERFORM (data->>'hiddenAt')::timestamptz;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
-- Drain backfill reference checks before DDL on populated workspaces.
SET CONSTRAINTS entity_reference_validation IMMEDIATE;
ALTER TABLE entities ADD CONSTRAINT artifact_metadata_valid CHECK(kind<>'artifact' OR pm_artifact_metadata_valid(data));
SET CONSTRAINTS entity_reference_validation DEFERRED;
CREATE INDEX artifacts_visible_page_idx ON entities(workspace_id,project_id,id) WHERE kind='artifact' AND data->'hiddenAt'='null'::jsonb;
CREATE INDEX artifacts_hidden_page_idx ON entities(workspace_id,project_id,id) WHERE kind='artifact' AND data->'hiddenAt'<>'null'::jsonb;
CREATE INDEX artifact_versions_parent_idx ON entities(workspace_id,(data->>'artifactId'),id) WHERE kind='artifact_version';

CREATE OR REPLACE FUNCTION pm_project_audit_fields() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['name','title','status','priority','archived','archivedAt','ownerId','assigneeId',
    'startDate','dueDate','targetDate','due','start','end','owner','assignee','x-pm-start',
    'favorite','artifactVersionId','mediaType','currency','budgetMinor','amountMinor',
    'remainingEstimateMinor','actualMinor','forecastMinor','asOfDate','spentOn','confidence',
    'completed','itemCount','completedCount','memberCount','teamCount','hiddenAt','hiddenBy']::text[]
$$;

CREATE TABLE artifact_copy_origins (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  target_artifact_version_id uuid NOT NULL, target_artifact_id uuid NOT NULL, target_project_id text NOT NULL,
  source_artifact_id uuid NOT NULL, source_artifact_version_id uuid NOT NULL, source_project_id text NOT NULL,
  copied_by uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL, copied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT artifact_copy_origin_primary PRIMARY KEY(workspace_id,target_artifact_version_id),
  CONSTRAINT artifact_copy_origin_command_unique UNIQUE(workspace_id,copied_by,command_id),
  CONSTRAINT artifact_copy_origin_independent CHECK(target_artifact_id<>source_artifact_id AND target_artifact_version_id<>source_artifact_version_id),
  CONSTRAINT artifact_copy_origin_target_version FOREIGN KEY(workspace_id,target_artifact_version_id) REFERENCES entities(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT artifact_copy_origin_target_artifact FOREIGN KEY(workspace_id,target_artifact_id) REFERENCES entities(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT artifact_copy_origin_source_version FOREIGN KEY(workspace_id,source_artifact_version_id) REFERENCES entities(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT artifact_copy_origin_source_artifact FOREIGN KEY(workspace_id,source_artifact_id) REFERENCES entities(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT artifact_copy_origin_receipt FOREIGN KEY(workspace_id,copied_by,command_id) REFERENCES command_receipts(workspace_id,actor_id,command_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION pm_validate_artifact_copy_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sa entities%ROWTYPE; sv entities%ROWTYPE; ta entities%ROWTYPE; tv entities%ROWTYPE; u entities%ROWTYPE;
BEGIN
  SELECT * INTO sa FROM entities WHERE workspace_id=NEW.workspace_id AND id=NEW.source_artifact_id;
  SELECT * INTO sv FROM entities WHERE workspace_id=NEW.workspace_id AND id=NEW.source_artifact_version_id;
  SELECT * INTO ta FROM entities WHERE workspace_id=NEW.workspace_id AND id=NEW.target_artifact_id;
  SELECT * INTO tv FROM entities WHERE workspace_id=NEW.workspace_id AND id=NEW.target_artifact_version_id;
  SELECT * INTO u FROM entities WHERE workspace_id=NEW.workspace_id AND id::text=tv.data->>'uploadId';
  IF sa.kind IS DISTINCT FROM 'artifact' OR ta.kind IS DISTINCT FROM 'artifact' OR sv.kind IS DISTINCT FROM 'artifact_version' OR tv.kind IS DISTINCT FROM 'artifact_version'
    OR sa.project_id IS DISTINCT FROM NEW.source_project_id OR sv.project_id IS DISTINCT FROM NEW.source_project_id
    OR ta.project_id IS DISTINCT FROM NEW.target_project_id OR tv.project_id IS DISTINCT FROM NEW.target_project_id
    OR sv.data->>'artifactId' IS DISTINCT FROM sa.id::text OR tv.data->>'artifactId' IS DISTINCT FROM ta.id::text
    OR NOT (sa.data->'versionRefs' ? sv.id::text) OR NOT (ta.data->'versionRefs' ? tv.id::text)
    OR ta.data #>> '{versionRefs,0}' IS DISTINCT FROM tv.id::text
    OR sv.data->'sha256' IS DISTINCT FROM tv.data->'sha256' OR sv.data->'contentDigest' IS DISTINCT FROM tv.data->'contentDigest'
    OR sv.data->'size' IS DISTINCT FROM tv.data->'size' OR sv.data->'fileName' IS DISTINCT FROM tv.data->'fileName' OR sv.data->'mediaType' IS DISTINCT FROM tv.data->'mediaType'
    OR sv.data->>'objectKey' IS NULL OR tv.data->>'objectKey' IS NULL OR sv.data->>'objectKey'=tv.data->>'objectKey'
    OR tv.data->>'producerId' IS DISTINCT FROM NEW.copied_by::text OR tv.data->'sourceRunId' IS DISTINCT FROM 'null'::jsonb
    OR u.kind IS DISTINCT FROM 'upload' OR u.project_id IS DISTINCT FROM NEW.target_project_id
    OR u.data->>'consumedByArtifactVersionId' IS DISTINCT FROM tv.id::text OR u.data->>'ownerId' IS DISTINCT FROM NEW.copied_by::text
    OR u.data->'objectKey' IS DISTINCT FROM tv.data->'objectKey'
    OR u.data->'sha256' IS DISTINCT FROM tv.data->'sha256' OR u.data->'size' IS DISTINCT FROM tv.data->'size'
    OR u.data->'fileName' IS DISTINCT FROM tv.data->'fileName' OR u.data->'mediaType' IS DISTINCT FROM tv.data->'mediaType'
    OR tv.data->'contentDigest' IS DISTINCT FROM tv.data->'sha256'
    THEN RAISE EXCEPTION 'invalid independent artifact copy origin' USING ERRCODE='23514', CONSTRAINT='artifact_copy_origin_valid'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER artifact_copy_origin_validation AFTER INSERT ON artifact_copy_origins DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pm_validate_artifact_copy_origin();
CREATE FUNCTION pm_artifact_copy_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'artifact copy origins are immutable' USING ERRCODE='23514',CONSTRAINT='artifact_copy_origin_immutable'; END $$;
CREATE TRIGGER artifact_copy_origin_history_guard BEFORE UPDATE OR DELETE ON artifact_copy_origins FOR EACH ROW EXECUTE FUNCTION pm_artifact_copy_origin_immutable();
CREATE TRIGGER artifact_copy_origin_truncate_guard BEFORE TRUNCATE ON artifact_copy_origins FOR EACH STATEMENT EXECUTE FUNCTION pm_artifact_copy_origin_immutable();

-- Bind helpers to their owning schema: pg_restore intentionally clears search_path.
DO $$
DECLARE own_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.pm_artifact_metadata_valid(jsonb) SET search_path TO pg_catalog, %I',own_schema,own_schema);
  EXECUTE format('ALTER FUNCTION %I.pm_validate_artifact_copy_origin() SET search_path TO pg_catalog, %I',own_schema,own_schema);
END $$;
