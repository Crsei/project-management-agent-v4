-- Additive only. Historical comments remain human-authored with unknown/no Agent origin.
-- No historical inference, content copy, production cleanup or Agent SQLite migration.
ALTER TABLE task_comments ADD COLUMN agent_origin jsonb;
ALTER TABLE task_comment_revisions ADD COLUMN agent_origin jsonb;

CREATE FUNCTION pm_task_comment_agent_origin_valid(value jsonb, workspace uuid, project text, task text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IS NULL OR coalesce(
    jsonb_typeof(value)='object'
    AND value ?& ARRAY['runId','agentId','agentVersion','delegationId','target','operationId','threadId','generationId']
    AND length(btrim(value->>'runId')) BETWEEN 1 AND 128
    AND length(btrim(value->>'agentId')) BETWEEN 1 AND 128
    AND jsonb_typeof(value->'agentVersion')='number' AND value->>'agentVersion' ~ '^[1-9][0-9]*$'
    AND (value->'delegationId'='null'::jsonb OR length(btrim(value->>'delegationId')) BETWEEN 1 AND 128)
    AND value->>'operationId' ~ '^[a-f0-9-]{36}$'
    AND length(value->>'threadId') BETWEEN 1 AND 200
    AND length(value->>'generationId') BETWEEN 1 AND 200
    AND value->'target'->>'workspaceId'=workspace::text
    AND value->'target'->>'projectId'=project AND value->'target'->>'taskId'=task
    AND value->'target'->>'taskRevision' ~ '^[a-f0-9]{64}$', false)
$$;
ALTER TABLE task_comments ADD CONSTRAINT task_comment_agent_origin_binding
  CHECK (pm_task_comment_agent_origin_valid(agent_origin,workspace_id,project_id,task_id));
CREATE INDEX task_comments_agent_run_idx ON task_comments(workspace_id,(agent_origin->>'runId'),id) WHERE agent_origin IS NOT NULL;

CREATE OR REPLACE FUNCTION pm_task_comment_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.agent_origin IS DISTINCT FROM OLD.agent_origin OR NEW.version <> OLD.version+1 THEN
    RAISE EXCEPTION 'task comment identity and origin are immutable and version must advance' USING ERRCODE='23514', CONSTRAINT='task_comment_update_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pm_task_comment_revision_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source task_comments;
BEGIN
  SELECT * INTO source FROM task_comments WHERE workspace_id=NEW.workspace_id AND id=NEW.comment_id;
  IF NOT FOUND OR NOT pm_task_comment_agent_origin_valid(NEW.agent_origin,NEW.workspace_id,source.project_id,source.task_id)
    OR (NEW.agent_origin IS NOT NULL AND NEW.agent_origin->>'operationId'<>NEW.command_id::text)
    OR (NEW.version=1 AND NEW.agent_origin IS DISTINCT FROM source.agent_origin) THEN
    RAISE EXCEPTION 'task comment revision origin does not match its original command and task' USING ERRCODE='23514', CONSTRAINT='task_comment_revision_origin_binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_comment_revisions_origin_guard BEFORE INSERT ON task_comment_revisions
  FOR EACH ROW EXECUTE FUNCTION pm_task_comment_revision_origin_guard();
