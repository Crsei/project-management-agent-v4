CREATE TABLE document_source_operations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  source_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','applying','succeeded','not_applied','unknown')),
  receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,actor_id,operation_id),
  CHECK (source_key='' OR source_key ~ '^PRJ-[0-9]+$'),
  CHECK ((status IN ('succeeded','not_applied')) = (receipt IS NOT NULL))
);
CREATE INDEX document_source_operations_pending ON document_source_operations(workspace_id) WHERE status IN ('prepared','applying','unknown');
