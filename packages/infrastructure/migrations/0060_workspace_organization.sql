-- Organization details are workspace-scoped and only readable/writable by
-- workspace administrators. Values are optional and normalized before storage.
ALTER TABLE workspaces
  ADD COLUMN tax_id text CHECK (tax_id IS NULL OR (tax_id = btrim(tax_id) AND length(tax_id) BETWEEN 1 AND 64)),
  ADD COLUMN business_address text CHECK (business_address IS NULL OR (business_address = btrim(business_address) AND length(business_address) BETWEEN 1 AND 300));
