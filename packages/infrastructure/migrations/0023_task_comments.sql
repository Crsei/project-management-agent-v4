-- PM-only collaboration. Core task/project identities and Markdown remain file-owned.
CREATE TABLE task_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Z][A-Z0-9]*-[0-9]+$'),
  task_id text NOT NULL CHECK (task_id ~ '^[A-Z][A-Z0-9]*-[0-9]+$'),
  author_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 16000),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,id)
);
CREATE INDEX task_comments_task_page_idx ON task_comments(workspace_id,project_id,task_id,id);
CREATE TABLE task_comment_revisions (
  workspace_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('created','edited','deleted','restored')),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 16000),
  actor_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,comment_id,version),
  UNIQUE(workspace_id,actor_id,command_id),
  FOREIGN KEY(workspace_id,comment_id) REFERENCES task_comments(workspace_id,id)
);
CREATE FUNCTION pm_task_comment_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task comment history cannot be erased' USING ERRCODE='23514', CONSTRAINT='task_comment_history_immutable';
END $$;
CREATE TRIGGER task_comments_delete_guard BEFORE DELETE ON task_comments FOR EACH ROW EXECUTE FUNCTION pm_task_comment_history_guard();
CREATE TRIGGER task_comments_truncate_guard BEFORE TRUNCATE ON task_comments FOR EACH STATEMENT EXECUTE FUNCTION pm_task_comment_history_guard();
CREATE TRIGGER task_comment_revisions_write_guard BEFORE UPDATE OR DELETE ON task_comment_revisions FOR EACH ROW EXECUTE FUNCTION pm_task_comment_history_guard();
CREATE TRIGGER task_comment_revisions_truncate_guard BEFORE TRUNCATE ON task_comment_revisions FOR EACH STATEMENT EXECUTE FUNCTION pm_task_comment_history_guard();
CREATE FUNCTION pm_task_comment_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.version <> OLD.version+1 THEN
    RAISE EXCEPTION 'task comment identity is immutable and version must advance' USING ERRCODE='23514', CONSTRAINT='task_comment_update_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_comments_update_guard BEFORE UPDATE ON task_comments FOR EACH ROW EXECUTE FUNCTION pm_task_comment_update_guard();
-- Every committed current version must have its exact immutable content snapshot.
CREATE FUNCTION pm_task_comment_revision_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM task_comment_revisions r WHERE r.workspace_id=NEW.workspace_id
    AND r.comment_id=NEW.id AND r.version=NEW.version AND r.content=NEW.content) THEN
    RAISE EXCEPTION 'task comment revision snapshot is required' USING ERRCODE='23514', CONSTRAINT='task_comment_revision_required';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER task_comments_revision_guard AFTER INSERT OR UPDATE ON task_comments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pm_task_comment_revision_required();
