-- Revoking authority must not destroy historical references or trap archived aggregates.
CREATE OR REPLACE FUNCTION pm_assert_member(ws uuid, ref text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ref IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=ws AND user_id=ref::uuid) THEN
    RAISE EXCEPTION 'member reference is outside workspace history' USING ERRCODE='23514', CONSTRAINT='entity_member_reference';
  END IF;
END $$;

CREATE FUNCTION pm_assert_active_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_id text; changed boolean := false;
BEGIN
  IF NEW.kind='project' THEN
    member_id := NEW.data->>'ownerId';
    IF TG_OP='INSERT' THEN changed := true;
    ELSE changed := (NEW.data->>'ownerId')::uuid IS DISTINCT FROM (OLD.data->>'ownerId')::uuid;
    END IF;
  ELSIF NEW.kind='work_item' THEN
    member_id := NEW.data->>'assigneeId';
    IF TG_OP='INSERT' THEN changed := true;
    ELSE changed := (NEW.data->>'assigneeId')::uuid IS DISTINCT FROM (OLD.data->>'assigneeId')::uuid;
    END IF;
  ELSIF NEW.kind='upload' AND TG_OP='INSERT' THEN
    member_id := NEW.data->>'ownerId'; changed := true;
  END IF;
  IF changed AND member_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=NEW.workspace_id AND m.user_id=member_id::uuid AND m.revoked_at IS NULL AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'new assignment requires active member' USING ERRCODE='23514', CONSTRAINT='entity_active_assignment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entity_active_assignment BEFORE INSERT OR UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION pm_assert_active_assignment();

-- UUID comparison is semantic, regardless of the case of JSON serialization.
DROP INDEX work_item_intent_conversion_unique;
CREATE UNIQUE INDEX work_item_intent_conversion_unique ON entities(workspace_id,((data #>> '{originIntentRef,intentId}')::uuid),((data #>> '{originIntentRef,acceptedRevision}')::integer))
  WHERE kind='work_item' AND data->'originIntentRef' IS NOT NULL AND data->'originIntentRef'<>'null'::jsonb;
DROP INDEX review_submission_unique;
CREATE UNIQUE INDEX review_submission_unique ON entities(workspace_id,((data->>'submissionId')::uuid)) WHERE kind='review';
DROP INDEX artifact_version_upload_unique;
CREATE UNIQUE INDEX artifact_version_upload_unique ON entities(workspace_id,((data->>'uploadId')::uuid)) WHERE kind='artifact_version';
