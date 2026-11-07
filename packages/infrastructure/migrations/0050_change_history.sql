ALTER TABLE workspaces ADD COLUMN change_history_head bigint NOT NULL DEFAULT 0 CHECK(change_history_head>=0);
CREATE TABLE change_history_streams (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), stream_key text NOT NULL, target jsonb NOT NULL, address jsonb,
 PRIMARY KEY(workspace_id,stream_key)
);
CREATE TABLE change_history_aliases (
 workspace_id uuid NOT NULL, alias_key text NOT NULL, stream_key text NOT NULL, address jsonb,
 PRIMARY KEY(workspace_id,alias_key), FOREIGN KEY(workspace_id,stream_key) REFERENCES change_history_streams(workspace_id,stream_key)
);
-- Snapshot bytes are private history, never copied into events, audit or notification payloads.
CREATE TABLE change_history_entries (
 workspace_id uuid NOT NULL, change_id uuid NOT NULL, sequence bigint NOT NULL CHECK(sequence>0), stream_key text NOT NULL,
 source_key text NOT NULL, source_digest text NOT NULL, target jsonb NOT NULL, entity_kind text NOT NULL, project_id text,
 change_kinds text[] NOT NULL, changed_fields text[] NOT NULL, origin text NOT NULL CHECK(origin IN ('manual','agent','automation','observation')),
 actor_id uuid, occurred_at timestamptz, observed_at timestamptz NOT NULL, completeness text NOT NULL CHECK(completeness IN ('exact','observed_endpoints','baseline','missing_before')),
 before_snapshot jsonb, after_snapshot jsonb, before_address jsonb, after_address jsonb, before_revision text, after_revision text, before_project text,
 PRIMARY KEY(workspace_id,change_id), UNIQUE(workspace_id,sequence), UNIQUE(workspace_id,source_key),
 FOREIGN KEY(workspace_id,stream_key) REFERENCES change_history_streams(workspace_id,stream_key)
);
CREATE INDEX change_history_target_page ON change_history_entries(workspace_id,stream_key,sequence DESC);
CREATE TABLE change_history_cursors (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), target_key text NOT NULL, reviewed_through bigint NOT NULL DEFAULT 0 CHECK(reviewed_through>=0),
 PRIMARY KEY(workspace_id,actor_id,target_key)
);
CREATE TABLE change_history_observations (
 token uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), actor_id uuid NOT NULL REFERENCES users(id), target_key text NOT NULL,
 through_sequence bigint NOT NULL CHECK(through_sequence>=0), includes_related boolean NOT NULL, scope_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX change_history_observations_owner ON change_history_observations(workspace_id,actor_id,target_key);
CREATE TRIGGER change_history_immutable BEFORE UPDATE OR DELETE ON change_history_entries FOR EACH ROW EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER change_history_truncate_guard BEFORE TRUNCATE ON change_history_entries FOR EACH STATEMENT EXECUTE FUNCTION pm_service_fact_immutable();
ALTER TABLE notification_fact_inputs ADD COLUMN completion boolean NOT NULL DEFAULT false;
ALTER TABLE notification_fact_inputs ADD COLUMN assignee_id uuid;
ALTER TABLE notification_fact_inputs ADD COLUMN requester_id uuid;
ALTER TABLE notification_fact_inputs ADD COLUMN trusted_origin text NOT NULL DEFAULT 'manual' CHECK(trusted_origin IN ('manual','agent','automation'));
ALTER TABLE notification_fact_inputs ADD COLUMN changed_fields text[] NOT NULL DEFAULT '{}';
ALTER TABLE notification_recipients DROP CONSTRAINT notification_recipients_reason_set_check;
ALTER TABLE notification_recipients ADD CONSTRAINT notification_recipients_reason_set_check CHECK(cardinality(reason_set)>0 AND reason_set <@ ARRAY['watch','mention','legacy_activity_state','assignee','requester','completion']::text[]);
-- REQ/DOC facts are stored safely, but do not become task notifications.
ALTER TABLE service_fact_events DROP CONSTRAINT service_fact_events_check;
ALTER TABLE service_fact_events ADD CONSTRAINT service_fact_events_check CHECK(safety_class<>'project_fact' OR (project_id IS NOT NULL AND entity_kind IN ('project','work_item','milestone','requirement','document') AND source_kind<>'legacy_activity'));
