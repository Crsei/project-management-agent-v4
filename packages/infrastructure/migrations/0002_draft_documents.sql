-- Draft projects and work items may be incomplete; lifecycle commands enforce readiness.
CREATE OR REPLACE FUNCTION pm_validate_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope uuid; ref text; item jsonb;
BEGIN
  scope := CASE WHEN NEW.kind='project' THEN NEW.id ELSE NEW.project_id END;
  IF NEW.project_id IS NOT NULL THEN PERFORM pm_assert_reference(NEW.workspace_id,NEW.project_id,NEW.project_id::text,'project'); END IF;
  IF NEW.kind='project' THEN
    IF jsonb_typeof(NEW.data->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.data->'completionCriteria') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid project document' USING ERRCODE='23514'; END IF;
    PERFORM pm_assert_member(NEW.workspace_id,NEW.data->>'ownerId');
  ELSIF NEW.kind='work_item' THEN
    IF jsonb_typeof(NEW.data->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.data->'acceptanceCriteria') IS DISTINCT FROM 'array' OR (NEW.data->>'status' IN ('ready','in_progress','in_review','done') AND jsonb_array_length(NEW.data->'acceptanceCriteria')<1) OR coalesce((NEW.data->>'contentRevision')::integer,0) < 1 THEN RAISE EXCEPTION 'invalid work item document' USING ERRCODE='23514'; END IF;
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
    IF NEW.data->>'workItemId' IS NULL OR jsonb_typeof(NEW.data->'artifactVersionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.data->'artifactVersionIds')<1 OR coalesce((NEW.data->>'contentRevision')::integer,0)<1 THEN RAISE EXCEPTION 'invalid submission document' USING ERRCODE='23514'; END IF;
    FOR ref IN SELECT jsonb_array_elements_text(NEW.data->'artifactVersionIds') LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'artifact_version'); END LOOP;
    FOR ref IN SELECT jsonb_array_elements_text(coalesce(NEW.data->'evidenceIds','[]')) LOOP PERFORM pm_assert_reference(NEW.workspace_id,scope,ref,'evidence'); END LOOP;
  ELSIF NEW.kind='review' THEN
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'submissionId','submission');
    PERFORM pm_assert_reference(NEW.workspace_id,scope,NEW.data->>'workItemId','work_item');
    IF NEW.data->>'submissionId' IS NULL OR NEW.data->>'workItemId' IS NULL OR NEW.data->>'verdict' NOT IN ('passed','changes_requested') OR jsonb_typeof(NEW.data->'criterionResults') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid review document' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
