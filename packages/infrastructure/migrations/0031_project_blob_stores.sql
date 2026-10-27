-- Paths remain owned by the Markdown core mapping; SQL stores identities only.
CREATE TABLE project_blob_stores (
  storage_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','migrating')),
  UNIQUE(workspace_id,project_id),
  UNIQUE(storage_id,workspace_id,project_id)
);
CREATE TABLE project_blob_object_routes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL,
  object_key text NOT NULL CHECK(object_key ~ '^sha256-[a-f0-9]{64}-[a-f0-9-]{36}\.blob$'),
  storage_id uuid NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  size integer NOT NULL CHECK(size BETWEEN 0 AND 8388608),
  PRIMARY KEY(workspace_id,project_id,object_key),
  FOREIGN KEY(storage_id,workspace_id,project_id) REFERENCES project_blob_stores(storage_id,workspace_id,project_id)
);
-- Old immutable receipt/version identities survive an explicit global cutover.
CREATE TABLE blob_store_aliases (
  storage_id uuid PRIMARY KEY,
  target_store_id uuid NOT NULL CHECK(storage_id <> target_store_id)
);
CREATE TABLE local_project_storage_operations (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL,
  operation_kind text NOT NULL CHECK(operation_kind IN ('migrate','relocate','rebind','restore')),
  target_root text NOT NULL,
  phase text NOT NULL CHECK(phase IN ('prepared','core_committed','copied','completed')),
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX local_project_storage_pending ON local_project_storage_operations(workspace_id,project_id) WHERE phase<>'completed';
-- A normal command may retain storage identity, never reassign an existing byte reference.
CREATE FUNCTION pm_blob_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('upload','artifact_version') AND NEW.data ? 'storageId' AND
    (jsonb_typeof(NEW.data->'storageId') IS DISTINCT FROM 'string' OR NEW.data->>'storageId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    THEN RAISE EXCEPTION 'invalid blob storage identity' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND OLD.kind IN ('upload','artifact_version') AND NEW.data->'storageId' IS DISTINCT FROM OLD.data->'storageId'
    THEN RAISE EXCEPTION 'blob storage identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER blob_identity_guard BEFORE INSERT OR UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION pm_blob_identity_guard();
