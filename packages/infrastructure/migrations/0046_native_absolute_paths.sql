-- Existing rows retain identities and revisions. Application guards still require
-- canonical local paths, allowed roots and ordinary non-link directories.
ALTER TABLE agent_file_areas DROP CONSTRAINT agent_file_areas_path_check;
ALTER TABLE agent_file_areas ADD CONSTRAINT agent_file_areas_path_check CHECK (
  length(path) BETWEEN 1 AND 4096 AND (left(path,1)='/' OR
    (left(path,1) ~ '^[A-Za-z]$' AND substring(path,2,1)=':' AND substring(path,3,1) IN ('/',chr(92))))
);
ALTER TABLE agent_storage_settings DROP CONSTRAINT agent_storage_settings_root_check;
ALTER TABLE agent_storage_settings ADD CONSTRAINT agent_storage_settings_root_check CHECK (
  length(default_root) BETWEEN 1 AND 4096 AND (left(default_root,1)='/' OR
    (left(default_root,1) ~ '^[A-Za-z]$' AND substring(default_root,2,1)=':' AND substring(default_root,3,1) IN ('/',chr(92))))
);
-- 0039 used an automatically named multicolumn CHECK. Resolve that exact
-- identity constraint through its three columns, not a guessed generated name.
DO $$
DECLARE identity_constraint text;
BEGIN
  SELECT constraint_row.conname INTO STRICT identity_constraint
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid='document_sources'::regclass AND constraint_row.contype='c'
      AND cardinality(constraint_row.conkey)=3
      AND constraint_row.conkey @> ARRAY(
        SELECT attnum FROM pg_attribute
        WHERE attrelid='document_sources'::regclass AND attname IN ('path','directory_device','directory_inode')
      )::smallint[];
  EXECUTE format('ALTER TABLE document_sources DROP CONSTRAINT %I', identity_constraint);
END $$;
ALTER TABLE document_sources ADD CONSTRAINT document_sources_identity_check CHECK (
  (path IS NULL AND directory_device IS NULL AND directory_inode IS NULL) OR
  (path IS NOT NULL AND directory_device IS NOT NULL AND directory_inode IS NOT NULL AND
    length(path) BETWEEN 1 AND 4096 AND (left(path,1)='/' OR
      (left(path,1) ~ '^[A-Za-z]$' AND substring(path,2,1)=':' AND substring(path,3,1) IN ('/',chr(92)))) AND
    directory_device ~ '^[0-9]+$' AND directory_inode ~ '^[0-9]+$')
);
