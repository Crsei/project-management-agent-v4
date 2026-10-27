CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  target_key text NOT NULL CHECK(target_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  project_ids text[] NOT NULL CHECK(cardinality(project_ids)>0 AND array_position(project_ids,NULL) IS NULL),
  event_types text[] NOT NULL CHECK(cardinality(event_types)>0 AND event_types <@ ARRAY['pm.project.changed.v1','pm.task.changed.v1','pm.milestone.changed.v1']::text[] AND array_position(event_types,NULL) IS NULL),
  authorizer_user_id uuid NOT NULL REFERENCES users(id),
  active_key_id text NOT NULL,
  activation_sequence bigint NOT NULL CHECK(activation_sequence>=0),
  state text NOT NULL DEFAULT 'paused' CHECK(state IN ('paused','enabled','retired','blocked')),
  safe_block_code text CHECK(safe_block_code ~ '^[a-z_]{1,80}$'),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id)
);
CREATE TABLE webhook_fact_consumptions (
  workspace_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('queued','filtered')),
  safe_reason text CHECK(safe_reason ~ '^[a-z_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(endpoint_id,fact_id),
  FOREIGN KEY(workspace_id,endpoint_id) REFERENCES webhook_endpoints(workspace_id,id),
  FOREIGN KEY(workspace_id,fact_id) REFERENCES service_fact_events(workspace_id,fact_id)
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
  payload_bytes bytea NOT NULL CHECK(octet_length(payload_bytes) BETWEEN 1 AND 4096),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','preparing','sending','retry_wait','failed_safe','blocked','suppressed','unknown','accepted')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no>=0),
  safe_retry_count integer NOT NULL DEFAULT 0 CHECK(safe_retry_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  key_id text,
  lease_id uuid,
  lease_kind text CHECK(lease_kind IN ('dispatch','reconcile')),
  lease_expires_at timestamptz,
  reconcile_requested boolean NOT NULL DEFAULT false,
  safe_failure_code text CHECK(safe_failure_code ~ '^[a-z_]{1,80}$'),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(endpoint_id,fact_id), UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,endpoint_id) REFERENCES webhook_endpoints(workspace_id,id),
  FOREIGN KEY(workspace_id,fact_id) REFERENCES service_fact_events(workspace_id,fact_id),
  CHECK ((lease_id IS NULL AND lease_kind IS NULL AND lease_expires_at IS NULL AND state NOT IN ('preparing','sending')) OR
    (lease_id IS NOT NULL AND lease_kind IS NOT NULL AND lease_expires_at IS NOT NULL AND ((lease_kind='dispatch' AND state IN ('preparing','sending')) OR (lease_kind='reconcile' AND state='unknown')))),
  CHECK ((state='accepted')=(accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX webhook_one_endpoint_lease ON webhook_deliveries(endpoint_id) WHERE lease_id IS NOT NULL;
CREATE INDEX webhook_dispatch_candidates ON webhook_deliveries(next_attempt_at,created_at,id) WHERE state IN ('ready','retry_wait');
CREATE INDEX webhook_reconcile_candidates ON webhook_deliveries(created_at,id) WHERE state='unknown' AND reconcile_requested;
CREATE INDEX webhook_delivery_history ON webhook_deliveries(workspace_id,endpoint_id,created_at DESC,id DESC);
CREATE TABLE webhook_delivery_attempts (
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id),
  attempt_no integer NOT NULL CHECK(attempt_no>0),
  attempt_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('dispatch','reconcile')),
  lease_id uuid NOT NULL,
  key_id text NOT NULL,
  request_body_sha256 text NOT NULL CHECK(request_body_sha256 ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  phase text NOT NULL CHECK(phase IN ('sending','accepted','not_accepted','unknown','failed_safe','pending')),
  safe_outcome_code text CHECK(safe_outcome_code ~ '^[a-z_]{1,80}$'),
  http_status integer CHECK(http_status BETWEEN 100 AND 599),
  PRIMARY KEY(delivery_id,attempt_no), UNIQUE(delivery_id,attempt_id)
);
CREATE TABLE webhook_delivery_receipts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  receiver_receipt_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('accepted','not_accepted','pending','unknown')),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  closed_through_attempt_no integer CHECK(closed_through_attempt_no>=0),
  verified_key_id text NOT NULL,
  response_sha256 text NOT NULL CHECK(response_sha256 ~ '^[a-f0-9]{64}$'),
  receiver_recorded_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(delivery_id,attempt_id) REFERENCES webhook_delivery_attempts(delivery_id,attempt_id),
  CHECK(status<>'not_accepted' OR closed_through_attempt_no IS NOT NULL),
  UNIQUE(delivery_id,receiver_receipt_id,status,attempt_id)
);
CREATE TABLE webhook_loop_health (
  worker_id text PRIMARY KEY,
  config_digest text,
  state text NOT NULL CHECK(state IN ('disabled','running','degraded','stopped')),
  cycle_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_key_health (
  worker_id text NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  config_digest text,
  ready_key_ids text[] NOT NULL CHECK(array_position(ready_key_ids,NULL) IS NULL),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker_id,endpoint_id)
);
CREATE INDEX webhook_key_health_refresh ON webhook_key_health(worker_id,checked_at,endpoint_id);
CREATE TABLE webhook_restore_fences (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  safe_reason text NOT NULL CHECK(safe_reason='receiver_ledger_alignment_required'),
  fenced_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_webhook_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Webhook history is retained' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='webhook_endpoints' THEN
    IF (NEW.id,NEW.workspace_id,NEW.target_key,NEW.target_digest,NEW.project_ids,NEW.event_types,NEW.activation_sequence,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.target_key,OLD.target_digest,OLD.project_ids,OLD.event_types,OLD.activation_sequence,OLD.created_at) OR (OLD.state='retired' AND NEW.state<>'retired') OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Immutable webhook endpoint identity or version' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='webhook_deliveries' THEN
    IF (NEW.id,NEW.workspace_id,NEW.endpoint_id,NEW.fact_id,NEW.target_digest,NEW.payload_bytes,NEW.payload_sha256,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.endpoint_id,OLD.fact_id,OLD.target_digest,OLD.payload_bytes,OLD.payload_sha256,OLD.created_at) OR NEW.version<>OLD.version+1 OR (OLD.state='accepted' AND NEW.state<>'accepted') THEN RAISE EXCEPTION 'Immutable webhook delivery identity or version' USING ERRCODE='23514'; END IF;
    IF OLD.state='unknown' AND NEW.state='ready' AND NOT EXISTS(SELECT 1 FROM webhook_delivery_receipts r WHERE r.delivery_id=OLD.id AND r.payload_sha256=OLD.payload_sha256 AND r.status='not_accepted' AND r.closed_through_attempt_no>=OLD.attempt_no) THEN RAISE EXCEPTION 'Unknown requires closed-attempt receiver evidence' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME IN ('webhook_delivery_receipts','webhook_fact_consumptions') THEN
    RAISE EXCEPTION 'Immutable webhook evidence' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='webhook_delivery_attempts' THEN
    IF (NEW.delivery_id,NEW.attempt_no,NEW.attempt_id,NEW.kind,NEW.lease_id,NEW.key_id,NEW.request_body_sha256,NEW.started_at) IS DISTINCT FROM (OLD.delivery_id,OLD.attempt_no,OLD.attempt_id,OLD.kind,OLD.lease_id,OLD.key_id,OLD.request_body_sha256,OLD.started_at) OR OLD.finished_at IS NOT NULL THEN RAISE EXCEPTION 'Immutable closed webhook attempt' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_endpoint_identity BEFORE UPDATE OR DELETE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION protect_webhook_history();
CREATE TRIGGER webhook_delivery_identity BEFORE UPDATE OR DELETE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION protect_webhook_history();
CREATE TRIGGER webhook_consumption_history BEFORE UPDATE OR DELETE ON webhook_fact_consumptions FOR EACH ROW EXECUTE FUNCTION protect_webhook_history();
CREATE TRIGGER webhook_attempt_history BEFORE UPDATE OR DELETE ON webhook_delivery_attempts FOR EACH ROW EXECUTE FUNCTION protect_webhook_history();
CREATE TRIGGER webhook_receipt_history BEFORE UPDATE OR DELETE ON webhook_delivery_receipts FOR EACH ROW EXECUTE FUNCTION protect_webhook_history();
CREATE FUNCTION webhook_accepted_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='accepted' AND NOT EXISTS(SELECT 1 FROM webhook_delivery_receipts r WHERE r.delivery_id=NEW.id AND r.status='accepted' AND r.payload_sha256=NEW.payload_sha256) THEN RAISE EXCEPTION 'Accepted webhook requires authenticated receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER webhook_accepted_evidence AFTER INSERT OR UPDATE ON webhook_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_accepted_evidence();
CREATE INDEX webhook_receiver_receipt_identity ON webhook_delivery_receipts(receiver_receipt_id);
CREATE FUNCTION webhook_receiver_receipt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.receiver_receipt_id::text,724632));
  IF EXISTS(SELECT 1 FROM webhook_delivery_receipts r WHERE r.receiver_receipt_id=NEW.receiver_receipt_id AND (r.delivery_id,r.payload_sha256,r.status) IS DISTINCT FROM (NEW.delivery_id,NEW.payload_sha256,NEW.status)) THEN RAISE EXCEPTION 'Receiver receipt identity conflict' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.id=NEW.delivery_id AND d.payload_sha256=NEW.payload_sha256) THEN RAISE EXCEPTION 'Receiver payload identity conflict' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_receiver_receipt_identity BEFORE INSERT ON webhook_delivery_receipts FOR EACH ROW EXECUTE FUNCTION webhook_receiver_receipt_identity();
CREATE FUNCTION webhook_consumption_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='webhook_fact_consumptions' THEN
    IF (NEW.decision='queued') IS DISTINCT FROM (EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.workspace_id=NEW.workspace_id AND d.endpoint_id=NEW.endpoint_id AND d.fact_id=NEW.fact_id)) THEN RAISE EXCEPTION 'Webhook consumption and delivery must commit together' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM webhook_fact_consumptions c WHERE c.workspace_id=NEW.workspace_id AND c.endpoint_id=NEW.endpoint_id AND c.fact_id=NEW.fact_id AND c.decision='queued') THEN RAISE EXCEPTION 'Webhook delivery requires its durable queued consumption' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER webhook_consumption_delivery AFTER INSERT ON webhook_fact_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_consumption_identity();
CREATE CONSTRAINT TRIGGER webhook_delivery_consumption AFTER INSERT ON webhook_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_consumption_identity();
