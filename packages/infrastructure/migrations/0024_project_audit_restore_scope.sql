-- pg_restore clears search_path while COPY checks existing audit history.
-- Bind the helper to its owning schema; do not weaken or disable the CHECK.
DO $$
DECLARE
  audit_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.pm_project_audit_safe_changes(jsonb) SET search_path TO pg_catalog, %I',
    audit_schema, audit_schema
  );
END $$;
