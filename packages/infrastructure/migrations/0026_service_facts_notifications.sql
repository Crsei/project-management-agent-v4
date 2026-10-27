-- Durable safe facts are independent of SSE retention and SQL task projections.
DO $$ DECLARE ws record; BEGIN
 FOR ws IN SELECT id FROM workspaces ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(ws.id::text,724631));
 END LOOP;
END $$;
ALTER TABLE workspaces ADD COLUMN service_fact_head bigint NOT NULL DEFAULT 0 CHECK(service_fact_head>=0);
ALTER TABLE workspaces ADD COLUMN notification_head bigint NOT NULL DEFAULT 0 CHECK(notification_head>=0);
CREATE TABLE service_fact_events (
 fact_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), fact_sequence bigint NOT NULL CHECK(fact_sequence>0),
 schema_version integer NOT NULL CHECK(schema_version=1), source_kind text NOT NULL CHECK(source_kind IN ('command','core_http','core_observation','legacy_activity')),
 source_key text NOT NULL, source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'), project_id text,
 entity_kind text NOT NULL, entity_id text NOT NULL, before_revision text, after_revision text,
 change_kinds text[] NOT NULL CHECK(change_kinds <@ ARRAY['created','metadata_changed','content_changed','lifecycle_changed']::text[]),
 occurred_at timestamptz, observed_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 safety_class text NOT NULL CHECK(safety_class IN ('project_fact','restricted_internal')),
 UNIQUE(workspace_id,fact_id), UNIQUE(workspace_id,fact_sequence), UNIQUE(workspace_id,source_kind,source_key),
 CHECK(safety_class<>'project_fact' OR (project_id IS NOT NULL AND entity_kind IN ('project','work_item','milestone') AND source_kind<>'legacy_activity'))
);
CREATE TABLE notification_fact_inputs (
 workspace_id uuid NOT NULL, fact_id uuid NOT NULL, actor_id uuid REFERENCES users(id), task_id text, comment_id uuid, comment_version integer,
 original_project_id text, audience_actor_id uuid, watch_candidates jsonb NOT NULL DEFAULT '[]', new_mention_ids uuid[] NOT NULL DEFAULT '{}',
 routing_policy_version integer NOT NULL DEFAULT 1 CHECK(routing_policy_version=1), legacy_event_type text, legacy_quarantined boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,fact_id), FOREIGN KEY(workspace_id,fact_id) REFERENCES service_fact_events(workspace_id,fact_id),
 CHECK(jsonb_typeof(watch_candidates)='array'), CHECK(cardinality(new_mention_ids)<=50)
);
CREATE TABLE notification_recipients (
 workspace_id uuid NOT NULL, fact_id uuid NOT NULL, recipient_id uuid NOT NULL REFERENCES users(id),
 reason_set text[] NOT NULL CHECK(cardinality(reason_set)>0 AND reason_set <@ ARRAY['watch','mention','legacy_activity_state']::text[]),
 origin text NOT NULL CHECK(origin IN ('routed','legacy_activity')), enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 delivery_cursor bigint NOT NULL CHECK(delivery_cursor>0), state_version integer NOT NULL DEFAULT 1 CHECK(state_version>=1), read_at timestamptz, archived_at timestamptz,
 PRIMARY KEY(workspace_id,fact_id,recipient_id), UNIQUE(workspace_id,delivery_cursor),
 FOREIGN KEY(workspace_id,fact_id) REFERENCES service_fact_events(workspace_id,fact_id)
);
CREATE INDEX notification_recipient_page ON notification_recipients(workspace_id,recipient_id,delivery_cursor);
CREATE TABLE notification_route_jobs (
 workspace_id uuid NOT NULL, fact_id uuid NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed')),
 lease_owner text, lease_until timestamptz, lease_epoch bigint NOT NULL DEFAULT 0, candidate_after text NOT NULL DEFAULT '',
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_error_code text,
 completed_count integer NOT NULL DEFAULT 0, skipped_count integer NOT NULL DEFAULT 0, completed_at timestamptz,
 PRIMARY KEY(workspace_id,fact_id), FOREIGN KEY(workspace_id,fact_id) REFERENCES service_fact_events(workspace_id,fact_id)
);
CREATE INDEX notification_jobs_due ON notification_route_jobs(next_attempt_at) WHERE state IN ('pending','running');
CREATE TABLE notification_route_retries (
 retry_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, fact_id uuid NOT NULL, operator_uid integer NOT NULL CHECK(operator_uid>=0),
 lease_epoch bigint NOT NULL, retried_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,fact_id) REFERENCES notification_route_jobs(workspace_id,fact_id)
);
CREATE TABLE notification_activations (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), activation_fact_sequence bigint NOT NULL, activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 routing_policy_version integer NOT NULL DEFAULT 1, migration_manifest jsonb NOT NULL, legacy_stream_cursor bigint NOT NULL
);
CREATE TABLE service_fact_import_checkpoints (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), imported_count bigint NOT NULL DEFAULT 0, observed_at timestamptz,
 journal_offset bigint NOT NULL DEFAULT 0 CHECK(journal_offset>=0), observation_sequence bigint NOT NULL DEFAULT 0 CHECK(observation_sequence>=0),
 status text NOT NULL DEFAULT 'unobserved' CHECK(status IN ('unobserved','current','pending','error')), last_error_code text
);
-- Migration runs within the existing global migration transaction: deployment must stop old writers/retention.
-- A fact retains original identity; only actors with an actually persisted state are imported.
WITH source AS (
 SELECT DISTINCT e.workspace_id,e.event_id,e.envelope,e.audience_actor_id FROM events e JOIN activity_states s USING(workspace_id,event_id)
 WHERE e.envelope->>'eventType'<>'ActivityStateChanged' AND e.envelope->>'aggregateKind'<>'activity_state'
), numbered AS (
 SELECT *,row_number() OVER(PARTITION BY workspace_id ORDER BY event_id) AS n FROM source
)
INSERT INTO service_fact_events(fact_id,workspace_id,fact_sequence,schema_version,source_kind,source_key,source_digest,project_id,entity_kind,entity_id,before_revision,after_revision,change_kinds,occurred_at,observed_at,safety_class)
SELECT event_id,workspace_id,n,1,'legacy_activity',event_id::text,
 encode(sha256(convert_to(jsonb_build_array(event_id,envelope->>'eventType',envelope->>'projectId',envelope->>'aggregateKind',envelope->>'aggregateId',envelope->>'aggregateVersion',envelope->>'occurredAt',audience_actor_id)::text,'UTF8')),'hex'),
 envelope->>'projectId',envelope->>'aggregateKind',envelope->>'aggregateId',NULL,envelope->>'aggregateVersion','{}',
 (envelope->>'occurredAt')::timestamptz,NULL,'restricted_internal' FROM numbered;
INSERT INTO notification_fact_inputs(workspace_id,fact_id,original_project_id,audience_actor_id,legacy_event_type,legacy_quarantined)
SELECT f.workspace_id,f.fact_id,f.project_id,e.audience_actor_id,e.envelope->>'eventType',
 e.audience_actor_id IS NULL AND f.entity_kind NOT IN ('project','work_item','milestone','conversation','intent','decision','upload','artifact','artifact_version','evidence','submission','review','membership','workspace_identity','project_team','member_capacity','project_health','project_budget','project_spend','project_scope','project_teams')
 FROM service_fact_events f JOIN events e ON e.workspace_id=f.workspace_id AND e.event_id=f.fact_id;
INSERT INTO notification_recipients(workspace_id,fact_id,recipient_id,reason_set,origin,delivery_cursor,state_version,read_at,archived_at)
SELECT s.workspace_id,s.event_id,s.actor_id,ARRAY['legacy_activity_state'],'legacy_activity',
 row_number() OVER(PARTITION BY s.workspace_id ORDER BY s.event_id,s.actor_id),s.version,s.read_at,s.archived_at
FROM activity_states s JOIN service_fact_events f ON f.workspace_id=s.workspace_id AND f.fact_id=s.event_id;
UPDATE workspaces w SET service_fact_head=(SELECT coalesce(max(f.fact_sequence),0) FROM service_fact_events f WHERE f.workspace_id=w.id),
 notification_head=(SELECT coalesce(max(r.delivery_cursor),0) FROM notification_recipients r WHERE r.workspace_id=w.id);
INSERT INTO notification_activations(workspace_id,activation_fact_sequence,legacy_stream_cursor,migration_manifest)
SELECT w.id,w.service_fact_head,w.stream_cursor,jsonb_build_object('legacyImplicitUnreadNotImported',true,'statesImported',(SELECT count(*) FROM notification_recipients r WHERE r.workspace_id=w.id),'identityVersionTimePreserved',NOT EXISTS(
 SELECT 1 FROM activity_states s JOIN service_fact_events f ON f.workspace_id=s.workspace_id AND f.fact_id=s.event_id
 LEFT JOIN notification_recipients r ON r.workspace_id=s.workspace_id AND r.fact_id=s.event_id AND r.recipient_id=s.actor_id
 WHERE s.workspace_id=w.id AND (r.fact_id IS NULL OR (s.version,s.read_at,s.archived_at) IS DISTINCT FROM (r.state_version,r.read_at,r.archived_at)))) FROM workspaces w;
DROP TABLE activity_states;
DROP FUNCTION pm_guard_activity_state();
CREATE FUNCTION pm_service_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'service fact and routing input history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER service_facts_immutable BEFORE UPDATE OR DELETE ON service_fact_events FOR EACH ROW EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_inputs_immutable BEFORE UPDATE OR DELETE ON notification_fact_inputs FOR EACH ROW EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER service_facts_truncate_guard BEFORE TRUNCATE ON service_fact_events FOR EACH STATEMENT EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_inputs_truncate_guard BEFORE TRUNCATE ON notification_fact_inputs FOR EACH STATEMENT EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_recipient_delete_guard BEFORE DELETE ON notification_recipients FOR EACH ROW EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_recipient_truncate_guard BEFORE TRUNCATE ON notification_recipients FOR EACH STATEMENT EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_retries_immutable BEFORE UPDATE OR DELETE ON notification_route_retries FOR EACH ROW EXECUTE FUNCTION pm_service_fact_immutable();
CREATE TRIGGER notification_retries_truncate_guard BEFORE TRUNCATE ON notification_route_retries FOR EACH STATEMENT EXECUTE FUNCTION pm_service_fact_immutable();
CREATE FUNCTION pm_notification_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.fact_id,NEW.recipient_id,NEW.reason_set,NEW.origin,NEW.enqueued_at,NEW.delivery_cursor) IS DISTINCT FROM
 (OLD.workspace_id,OLD.fact_id,OLD.recipient_id,OLD.reason_set,OLD.origin,OLD.enqueued_at,OLD.delivery_cursor) OR NEW.state_version<>OLD.state_version+1 THEN
 RAISE EXCEPTION 'notification identity is immutable and state requires next version' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER notification_state_guard BEFORE UPDATE ON notification_recipients FOR EACH ROW EXECUTE FUNCTION pm_notification_state_guard();
