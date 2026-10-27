-- Audit starts with authenticated controlled writes after this migration. No backfill
-- attributes historical or external filesystem activity to an invented actor.
-- 0001 also installed an unnamed whitelist alongside the named 0007 guard.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_capabilities_check;
ALTER TABLE memberships DROP CONSTRAINT memberships_capabilities_whitelist;
ALTER TABLE memberships ADD CONSTRAINT memberships_capabilities_whitelist CHECK (
  capabilities <@ ARRAY['domain.read','audit.read','intent.propose','intent.decide','planning.edit','planning.lifecycle',
    'workitem.cancel_reopen','delivery.write','delivery.submit','delivery.review','workitem.complete','access.manage']::text[]
);

CREATE FUNCTION pm_project_audit_fields() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['name','title','status','priority','archived','archivedAt','ownerId','assigneeId',
    'startDate','dueDate','targetDate','due','start','end','owner','assignee','x-pm-start',
    'favorite','artifactVersionId','mediaType','currency','budgetMinor','amountMinor',
    'remainingEstimateMinor','actualMinor','forecastMinor','asOfDate','spentOn','confidence',
    'completed','itemCount','completedCount','memberCount','teamCount']::text[]
$$;
CREATE FUNCTION pm_project_audit_safe_changes(changes jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE change jsonb; value jsonb;
BEGIN
  IF jsonb_typeof(changes) <> 'array' OR jsonb_array_length(changes) > 40 THEN RETURN false; END IF;
  FOR change IN SELECT jsonb_array_elements(changes) LOOP
    IF jsonb_typeof(change) <> 'object' OR NOT (change ?& ARRAY['field','before','after'])
      OR (SELECT count(*) FROM jsonb_object_keys(change)) <> 3
      OR NOT coalesce(change->>'field' = ANY(pm_project_audit_fields()),false) THEN RETURN false; END IF;
    FOREACH value IN ARRAY ARRAY[change->'before',change->'after'] LOOP
      IF jsonb_typeof(value) NOT IN ('string','number','boolean','null')
        OR jsonb_typeof(value)='string' AND length(value#>>'{}')>500 THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;
CREATE TABLE project_audit (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 80),
  source text NOT NULL CHECK (source IN ('command','core_http')),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  actor_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 80),
  target_kind text NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 80),
  before_version text CHECK (length(before_version) BETWEEN 1 AND 128),
  after_version text CHECK (length(after_version) BETWEEN 1 AND 128),
  changes jsonb NOT NULL CHECK (pm_project_audit_safe_changes(changes)),
  audience_actor_id uuid REFERENCES users(id),
  dedupe_key text NOT NULL,
  CONSTRAINT project_audit_private_actor CHECK (audience_actor_id IS NULL OR audience_actor_id=actor_id),
  CONSTRAINT project_audit_command_fact_unique UNIQUE(workspace_id,actor_id,command_id,source,dedupe_key)
);
CREATE INDEX project_audit_project_page_idx ON project_audit(workspace_id,project_id,id DESC);
CREATE FUNCTION pm_project_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project audit history is immutable' USING ERRCODE='23514', CONSTRAINT='project_audit_immutable';
END $$;
CREATE TRIGGER project_audit_history_guard BEFORE UPDATE OR DELETE ON project_audit FOR EACH ROW EXECUTE FUNCTION pm_project_audit_immutable();
CREATE TRIGGER project_audit_truncate_guard BEFORE TRUNCATE ON project_audit FOR EACH STATEMENT EXECUTE FUNCTION pm_project_audit_immutable();

CREATE FUNCTION pm_project_audit_snapshot(data jsonb, kind text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE snapshot jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO snapshot FROM jsonb_each(data)
    WHERE key=ANY(pm_project_audit_fields()) AND jsonb_typeof(value) IN ('string','number','boolean','null')
    AND (jsonb_typeof(value)<>'string' OR length(value#>>'{}')<=500);
  IF kind='project_scope' AND jsonb_typeof(data->'items')='array' THEN
    snapshot := snapshot || jsonb_build_object('itemCount',jsonb_array_length(data->'items'),'completedCount',
      (SELECT count(*) FROM jsonb_array_elements(data->'items') item WHERE item->'completed'='true'::jsonb));
  END IF;
  IF kind='project_team' AND jsonb_typeof(data->'memberIds')='array' THEN
    snapshot := snapshot || jsonb_build_object('memberCount',jsonb_array_length(data->'memberIds'));
  END IF;
  IF kind='project_team_assignment' AND jsonb_typeof(data->'teamIds')='array' THEN
    snapshot := snapshot || jsonb_build_object('teamCount',jsonb_array_length(data->'teamIds'));
  END IF;
  RETURN snapshot;
END $$;
CREATE FUNCTION pm_audit_project_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid; command text; action text; project text; audience uuid;
  previous jsonb := '{}'::jsonb; following jsonb; differences jsonb; initial_version text;
BEGIN
  -- Only the authenticated application command transaction supplies these values.
  -- Maintenance, old rows and unrelated external SQL are not attributed to a user.
  actor := nullif(current_setting('pm.audit_actor',true),'')::uuid;
  command := nullif(current_setting('pm.audit_command',true),'');
  action := nullif(current_setting('pm.audit_action',true),'');
  IF actor IS NULL OR command IS NULL OR action IS NULL
    OR NEW.workspace_id::text IS DISTINCT FROM current_setting('pm.audit_workspace',true) THEN RETURN NEW; END IF;
  project := CASE WHEN TG_TABLE_NAME='entities' AND NEW.kind='project' THEN NEW.id::text
    WHEN TG_TABLE_NAME='dashboard_records' AND NEW.kind IN ('time_timer','time_worklog') THEN NEW.data->>'projectId'
    ELSE NEW.project_id END;
  IF project IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='dashboard_records' THEN audience := NEW.owner_id; END IF;
  IF current_setting('pm.audit_private',true)='true' THEN audience := actor; END IF;
  following := pm_project_audit_snapshot(NEW.data,NEW.kind);
  IF TG_OP='UPDATE' THEN previous := pm_project_audit_snapshot(OLD.data,OLD.kind); initial_version := OLD.version::text; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('field',field,'before',coalesce(previous->field,'null'::jsonb),'after',coalesce(following->field,'null'::jsonb)) ORDER BY field),'[]'::jsonb)
    INTO differences FROM unnest(pm_project_audit_fields()) field
    WHERE coalesce(previous->field,'null'::jsonb) IS DISTINCT FROM coalesce(following->field,'null'::jsonb);
  INSERT INTO project_audit(workspace_id,project_id,source,command_id,action,actor_id,target_id,target_kind,before_version,after_version,changes,audience_actor_id,dedupe_key)
    VALUES(NEW.workspace_id,project,'command',command,action,actor,NEW.id::text,NEW.kind,initial_version,NEW.version::text,differences,audience,
      jsonb_build_array(project,NEW.id::text,initial_version,NEW.version::text)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER entities_project_audit AFTER INSERT OR UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION pm_audit_project_record();
CREATE TRIGGER dashboard_records_project_audit AFTER INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_audit_project_record();
