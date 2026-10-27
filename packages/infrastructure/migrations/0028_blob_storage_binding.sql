CREATE TABLE blob_storage_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  store_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('local', 's3')),
  locator_sha256 text NOT NULL CHECK (locator_sha256 ~ '^[a-f0-9]{64}$'),
  epoch bigint NOT NULL CHECK (epoch > 0),
  state text NOT NULL CHECK (state IN ('active', 'migrating')),
  verified_manifest_sha256 text CHECK (verified_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((verified_manifest_sha256 IS NULL) = (verified_at IS NULL))
);

-- Maintenance history is separate from immutable business receipts/entities.
CREATE TABLE blob_storage_operations (
  operation_id uuid PRIMARY KEY,
  operation_kind text NOT NULL CHECK (operation_kind IN ('bind_new', 'bind_adopt', 'migrate', 'activate', 'restore_rebind', 'resume_source')),
  expected_epoch bigint NOT NULL CHECK (expected_epoch >= 0),
  source_binding jsonb,
  target_binding jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION pm_blob_storage_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Blob storage operation history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER blob_storage_operation_immutable BEFORE UPDATE OR DELETE ON blob_storage_operations
FOR EACH ROW EXECUTE FUNCTION pm_blob_storage_operation_immutable();

-- This migration intentionally creates no binding/marker. Explicit offline bind is required.
