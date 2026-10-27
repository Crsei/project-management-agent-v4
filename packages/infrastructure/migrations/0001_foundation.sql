CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200), password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200), owner_id uuid NOT NULL REFERENCES users(id),
  stream_cursor bigint NOT NULL DEFAULT 0 CHECK (stream_cursor >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id), capabilities text[] NOT NULL,
  project_ids uuid[], version integer NOT NULL DEFAULT 1 CHECK (version > 0), revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id),
  CHECK (capabilities <@ ARRAY['domain.read','intent.propose','intent.decide','planning.edit','planning.lifecycle','workitem.cancel_reopen','delivery.write','delivery.submit','delivery.review','workitem.complete','access.manage']::text[]),
  CHECK (array_position(capabilities,NULL) IS NULL AND array_position(project_ids,NULL) IS NULL),
  CHECK (NOT ('access.manage'=ANY(capabilities)) OR project_ids IS NULL)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'), user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE entities (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), project_id uuid,
  kind text NOT NULL CHECK (kind IN ('project','work_item','milestone','conversation','intent','decision','upload','artifact','artifact_version','evidence','submission','review')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES users(id),
  UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,project_id) REFERENCES entities(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((kind='project' AND project_id IS NULL) OR kind IN ('conversation','intent','decision') OR project_id IS NOT NULL)
);
CREATE INDEX entities_scope_kind_idx ON entities(workspace_id,kind,project_id,id);
CREATE UNIQUE INDEX work_item_intent_conversion_unique ON entities(workspace_id,(data #>> '{originIntentRef,intentId}'),(data #>> '{originIntentRef,acceptedRevision}'))
  WHERE kind='work_item' AND data->'originIntentRef' IS NOT NULL AND data->'originIntentRef'<>'null'::jsonb;
CREATE UNIQUE INDEX review_submission_unique ON entities(workspace_id,(data->>'submissionId')) WHERE kind='review';
CREATE UNIQUE INDEX artifact_version_upload_unique ON entities(workspace_id,(data->>'uploadId')) WHERE kind='artifact_version';
CREATE UNIQUE INDEX upload_object_key_unique ON entities((data->>'objectKey')) WHERE kind='upload';
CREATE TABLE command_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL,
  command_type text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), project_id uuid,
  scope_project_ids uuid[] NOT NULL DEFAULT '{}', workspace_scope integer NOT NULL DEFAULT 0 CHECK(workspace_scope IN (0,1)),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND receipt->>'status' IN ('committed','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,actor_id,command_id)
);
CREATE TABLE outbox (
  id bigserial PRIMARY KEY, event_id uuid NOT NULL UNIQUE, workspace_id uuid NOT NULL REFERENCES workspaces(id), project_id uuid,
  aggregate_id uuid NOT NULL, aggregate_kind text NOT NULL, aggregate_version integer NOT NULL CHECK(aggregate_version > 0),
  aggregate_sequence bigint NOT NULL CHECK(aggregate_sequence > 0), event_type text NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  actor_id uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0), last_error text,
  UNIQUE(workspace_id,aggregate_id,aggregate_sequence)
);
CREATE INDEX outbox_unpublished_idx ON outbox(workspace_id,id) WHERE published_at IS NULL;
CREATE TABLE events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), cursor bigint NOT NULL CHECK(cursor > 0), event_id uuid NOT NULL UNIQUE,
  envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,cursor)
);
CREATE INDEX events_retention_idx ON events(created_at);
CREATE TABLE service_heartbeats (id text PRIMARY KEY, role text NOT NULL, heartbeat_at timestamptz NOT NULL, details jsonb NOT NULL DEFAULT '{}');

-- JSONB stores a versioned aggregate document, while relational scope and typed references remain enforced.
CREATE FUNCTION pm_assert_reference(ws uuid, project uuid, ref text, expected_kind text DEFAULT NULL, allow_workspace boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE found entities%ROWTYPE; target_project uuid;
BEGIN
  IF ref IS NULL THEN RETURN; END IF;
  SELECT * INTO found FROM entities WHERE workspace_id=ws AND id=ref::uuid;
  IF NOT FOUND OR (expected_kind IS NOT NULL AND found.kind<>expected_kind) THEN
    RAISE EXCEPTION 'invalid entity reference' USING ERRCODE='23514', CONSTRAINT='entity_reference_type_scope';
  END IF;
  target_project := CASE WHEN found.kind='project' THEN found.id ELSE found.project_id END;
  IF target_project IS DISTINCT FROM project AND NOT (allow_workspace AND target_project IS NULL) THEN
    RAISE EXCEPTION 'cross-project reference' USING ERRCODE='23514', CONSTRAINT='entity_reference_type_scope';
  END IF;
END $$;
CREATE FUNCTION pm_assert_member(ws uuid, ref text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=ws AND m.user_id=ref::uuid AND m.revoked_at IS NULL AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'member reference is not active' USING ERRCODE='23514', CONSTRAINT='entity_member_reference';
  END IF;
END $$;
CREATE FUNCTION pm_validate_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope uuid; ref text; item jsonb;
BEGIN
  scope := CASE WHEN NEW.kind='project' THEN NEW.id ELSE NEW.project_id END;
  IF NEW.project_id IS NOT NULL THEN PERFORM pm_assert_reference(NEW.workspace_id,NEW.project_id,NEW.project_id::text,'project'); END IF;
  IF NEW.kind='project' THEN
    IF jsonb_typeof(NEW.data->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.data->'completionCriteria') IS DISTINCT FROM 'array' OR NEW.data->>'ownerId' IS NULL THEN RAISE EXCEPTION 'invalid project document' USING ERRCODE='23514'; END IF;
    PERFORM pm_assert_member(NEW.workspace_id,NEW.data->>'ownerId');
  ELSIF NEW.kind='work_item' THEN
    IF jsonb_typeof(NEW.data->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.data->'acceptanceCriteria') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.data->'acceptanceCriteria')<1 OR (NEW.data->>'contentRevision')::integer < 1 THEN RAISE EXCEPTION 'invalid work item document' USING ERRCODE='23514'; END IF;
    PERFORM pm_assert_member(NEW.workspace_id,NEW.data->>'assigneeId');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'milestoneId','milestone');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'currentSubmissionId','submission');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data #>> '{originIntentRef,intentId}','intent',true);
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data #>> '{originIntentRef,decisionId}','decision',true);
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'prerequisiteIds','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'work_item'); END LOOP;
  ELSIF NEW.kind='intent' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'conversationId','conversation');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'acceptedDecisionId','decision');
  ELSIF NEW.kind='decision' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data #>> '{subjectRef,id}',NEW.data #>> '{subjectRef,kind}');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'supersedesDecisionId','decision');
    FOR item IN SELECT jsonb_array_elements(coalesce(NEW.data->'basisRefs','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,item->>'id',item->>'kind'); END LOOP;
  ELSIF NEW.kind='upload' THEN
    PERFORM pm_assert_member(NEW.workspace_id,NEW.data->>'ownerId');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'consumedByArtifactVersionId','artifact_version');
    IF (NEW.data->>'sha256') !~ '^[a-f0-9]{64}$' OR (NEW.data->>'size')::bigint < 0 OR NEW.data->>'objectKey' IS NULL THEN RAISE EXCEPTION 'invalid upload document' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='artifact' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'latestVersionId','artifact_version');
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'versionRefs','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'artifact_version'); END LOOP;
  ELSIF NEW.kind='artifact_version' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'artifactId','artifact');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'uploadId','upload');
    IF NEW.data->>'sourceRunId' IS NOT NULL OR NEW.data->>'artifactId' IS NULL OR NEW.data->>'uploadId' IS NULL OR (NEW.data->>'sha256') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid artifact version document' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='evidence' THEN
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'subjectRefs','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref); END LOOP;
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'artifactVersionRefs','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'artifact_version'); END LOOP;
    IF NEW.data->>'sourceRunId' IS NOT NULL OR NEW.data->>'result' NOT IN ('pass','fail','inconclusive') THEN RAISE EXCEPTION 'invalid evidence document' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='submission' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'workItemId','work_item');
    IF NEW.data->>'workItemId' IS NULL OR jsonb_typeof(NEW.data->'artifactVersionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.data->'artifactVersionIds')<1 OR (NEW.data->>'contentRevision')::integer<1 THEN RAISE EXCEPTION 'invalid submission document' USING ERRCODE='23514'; END IF;
    FOR ref IN SELECT jsonb_array_elements_text(NEW.data->'artifactVersionIds') LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'artifact_version'); END LOOP;
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'evidenceIds','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'evidence'); END LOOP;
  ELSIF NEW.kind='review' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'submissionId','submission');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'workItemId','work_item');
    IF NEW.data->>'submissionId' IS NULL OR NEW.data->>'workItemId' IS NULL OR NEW.data->>'verdict' NOT IN ('passed','changes_requested') OR jsonb_typeof(NEW.data->'criterionResults') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid review document' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entity_reference_validation AFTER INSERT OR UPDATE ON entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pm_validate_entity();
CREATE FUNCTION pm_guard_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'entities are retained for audit' USING ERRCODE='23514', CONSTRAINT='entity_history_retained'; END IF;
  IF OLD.kind IN ('decision','artifact_version','evidence','submission','review') THEN RAISE EXCEPTION 'immutable entity' USING ERRCODE='23514', CONSTRAINT='entity_immutable'; END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.project_id,NEW.kind,NEW.created_at,NEW.created_by) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.project_id,OLD.kind,OLD.created_at,OLD.created_by) OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'invalid entity version or identity update' USING ERRCODE='23514', CONSTRAINT='entity_identity_version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entity_history_guard BEFORE UPDATE OR DELETE ON entities FOR EACH ROW EXECUTE FUNCTION pm_guard_entity();
CREATE FUNCTION pm_guard_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'command receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER receipt_history_guard BEFORE UPDATE OR DELETE ON command_receipts FOR EACH ROW EXECUTE FUNCTION pm_guard_receipt();
