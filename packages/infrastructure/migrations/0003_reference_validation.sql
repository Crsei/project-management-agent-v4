-- Avoid shadowing PL/pgSQL's FOUND status flag with the selected entity record.
CREATE OR REPLACE FUNCTION pm_assert_reference(ws uuid, project uuid, ref text, expected_kind text DEFAULT NULL, allow_workspace boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE referenced entities%ROWTYPE; target_project uuid;
BEGIN
  IF ref IS NULL THEN RETURN; END IF;
  SELECT * INTO referenced FROM entities WHERE workspace_id=ws AND id=ref::uuid;
  IF NOT FOUND OR (expected_kind IS NOT NULL AND referenced.kind<>expected_kind) THEN
    RAISE EXCEPTION 'invalid entity reference' USING ERRCODE='23514', CONSTRAINT='entity_reference_type_scope';
  END IF;
  target_project := CASE WHEN referenced.kind='project' THEN referenced.id ELSE referenced.project_id END;
  IF target_project IS DISTINCT FROM project AND NOT (allow_workspace AND target_project IS NULL) THEN
    RAISE EXCEPTION 'cross-project reference' USING ERRCODE='23514', CONSTRAINT='entity_reference_type_scope';
  END IF;
END $$;
