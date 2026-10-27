-- Financial and health history is append-only; only current heads use CAS updates.
CREATE UNIQUE INDEX dashboard_portfolio_head_unique ON dashboard_records(workspace_id, project_id, kind)
  WHERE kind IN ('portfolio_health', 'portfolio_budget');
CREATE UNIQUE INDEX dashboard_portfolio_spend_void_unique ON dashboard_records(workspace_id, (data->>'spendId'))
  WHERE kind = 'portfolio_spend_void';
CREATE INDEX dashboard_portfolio_history_idx ON dashboard_records(workspace_id, project_id, kind, created_at, id)
  WHERE kind IN ('portfolio_health_assessment','portfolio_spend','portfolio_spend_void','portfolio_financial_snapshot');

CREATE FUNCTION pm_portfolio_minor(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'number'
    THEN value::text::numeric BETWEEN 0 AND 9007199254740991 AND value::text::numeric = trunc(value::text::numeric)
    ELSE false END
$$;

CREATE FUNCTION pm_guard_portfolio_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reference dashboard_records%ROWTYPE;
  head dashboard_records%ROWTYPE;
  entry jsonb;
  date_text text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind IN ('portfolio_health_assessment','portfolio_spend','portfolio_spend_void','portfolio_financial_snapshot') THEN
    RAISE EXCEPTION 'portfolio history is immutable' USING ERRCODE='23514', CONSTRAINT='portfolio_history_immutable';
  END IF;
  IF NEW.kind NOT IN ('portfolio_health','portfolio_health_assessment','portfolio_budget','portfolio_spend','portfolio_spend_void','portfolio_financial_snapshot') THEN
    RETURN NEW;
  END IF;
  IF NEW.project_id IS NULL OR NEW.owner_id IS NOT NULL THEN
    RAISE EXCEPTION 'portfolio record requires public project scope' USING ERRCODE='23514', CONSTRAINT='portfolio_project_scope';
  END IF;
  IF NEW.kind IN ('portfolio_health','portfolio_health_assessment') THEN
    IF NOT coalesce(NEW.data->>'status' IN ('on_track','at_risk','off_track')
      AND jsonb_typeof(NEW.data->'rationale')='string' AND length(trim(NEW.data->>'rationale')) BETWEEN 1 AND 16000
      AND jsonb_typeof(NEW.data->'risks')='array' AND jsonb_array_length(NEW.data->'risks') <= 100
      AND jsonb_typeof(NEW.data->'assessedBy')='string' AND jsonb_typeof(NEW.data->'assessedAt')='string', false)
      OR ((TG_OP='INSERT' OR NEW.kind='portfolio_health_assessment') AND NEW.data->>'assessedBy' IS DISTINCT FROM NEW.created_by::text) THEN
      RAISE EXCEPTION 'invalid health assessment' USING ERRCODE='23514', CONSTRAINT='portfolio_health_data';
    END IF;
    PERFORM (NEW.data->>'assessedAt')::timestamptz;
    FOR entry IN SELECT * FROM jsonb_array_elements(NEW.data->'risks') LOOP
      IF NOT coalesce(jsonb_typeof(entry)='object' AND jsonb_typeof(entry->'description')='string'
        AND length(trim(entry->>'description')) BETWEEN 1 AND 16000
        AND entry->>'severity' IN ('low','medium','high')
        AND jsonb_typeof(entry->'mitigation')='string' AND length(entry->>'mitigation') <= 16000, false) THEN
        RAISE EXCEPTION 'invalid health risk' USING ERRCODE='23514', CONSTRAINT='portfolio_risk_data';
      END IF;
    END LOOP;
  END IF;
  IF NEW.kind IN ('portfolio_budget','portfolio_spend','portfolio_financial_snapshot') THEN
    IF NOT coalesce(NEW.data->>'currency' ~ '^[A-Z]{3}$', false) THEN
      RAISE EXCEPTION 'explicit currency required' USING ERRCODE='23514', CONSTRAINT='portfolio_currency';
    END IF;
    date_text := CASE WHEN NEW.kind='portfolio_spend' THEN NEW.data->>'spentOn' ELSE NEW.data->>'asOfDate' END;
    IF date_text IS NULL OR date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR date_text::date::text <> date_text OR date_text::date > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'actual non-future financial date required' USING ERRCODE='23514', CONSTRAINT='portfolio_financial_date';
    END IF;
  END IF;
  IF NEW.kind IN ('portfolio_budget','portfolio_financial_snapshot') THEN
    IF NOT (pm_portfolio_minor(NEW.data->'budgetMinor') AND pm_portfolio_minor(NEW.data->'remainingEstimateMinor')) THEN
      RAISE EXCEPTION 'safe integer money required' USING ERRCODE='23514', CONSTRAINT='portfolio_safe_money';
    END IF;
    IF TG_OP='UPDATE' AND NEW.kind='portfolio_budget' AND NEW.data->>'currency' IS DISTINCT FROM OLD.data->>'currency'
      AND EXISTS (SELECT 1 FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND kind='portfolio_spend') THEN
      RAISE EXCEPTION 'currency is locked by spend ledger' USING ERRCODE='23514', CONSTRAINT='portfolio_currency_locked';
    END IF;
  END IF;
  IF NEW.kind='portfolio_financial_snapshot' THEN
    IF NOT (pm_portfolio_minor(NEW.data->'actualMinor') AND pm_portfolio_minor(NEW.data->'forecastMinor'))
      OR (NEW.data->>'forecastMinor')::numeric <> (NEW.data->>'actualMinor')::numeric + (NEW.data->>'remainingEstimateMinor')::numeric THEN
      RAISE EXCEPTION 'forecast must equal actual plus remaining' USING ERRCODE='23514', CONSTRAINT='portfolio_forecast';
    END IF;
  END IF;
  IF NEW.kind='portfolio_spend' THEN
    IF NOT pm_portfolio_minor(NEW.data->'amountMinor') OR (NEW.data->>'amountMinor')::numeric=0
      OR NOT coalesce(jsonb_typeof(NEW.data->'description')='string' AND length(trim(NEW.data->>'description')) BETWEEN 1 AND 16000, false) THEN
      RAISE EXCEPTION 'positive safe integer spend required' USING ERRCODE='23514', CONSTRAINT='portfolio_spend_data';
    END IF;
    SELECT * INTO head FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND kind='portfolio_budget';
    IF head.id IS NULL OR head.data->>'currency' IS DISTINCT FROM NEW.data->>'currency' THEN
      RAISE EXCEPTION 'spend requires matching project currency' USING ERRCODE='23514', CONSTRAINT='portfolio_spend_currency';
    END IF;
    IF NEW.data->>'correctsSpendId' IS NOT NULL THEN
      SELECT * INTO reference FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND id=(NEW.data->>'correctsSpendId')::uuid AND kind='portfolio_spend';
      IF reference.id IS NULL OR reference.project_id IS DISTINCT FROM NEW.project_id OR NOT EXISTS (
        SELECT 1 FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND kind='portfolio_spend_void' AND data->>'spendId'=reference.id::text
      ) THEN
        RAISE EXCEPTION 'correction requires original void record' USING ERRCODE='23514', CONSTRAINT='portfolio_correction_reference';
      END IF;
    END IF;
  END IF;
  IF NEW.kind='portfolio_spend_void' THEN
    SELECT * INTO reference FROM dashboard_records WHERE workspace_id=NEW.workspace_id AND id=(NEW.data->>'spendId')::uuid AND kind='portfolio_spend';
    IF reference.id IS NULL OR reference.project_id IS DISTINCT FROM NEW.project_id
      OR NOT coalesce(jsonb_typeof(NEW.data->'reason')='string' AND length(trim(NEW.data->>'reason')) BETWEEN 1 AND 16000, false) THEN
      RAISE EXCEPTION 'void requires original same-project spend and reason' USING ERRCODE='23514', CONSTRAINT='portfolio_void_reference';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dashboard_portfolio_guard BEFORE INSERT OR UPDATE ON dashboard_records FOR EACH ROW EXECUTE FUNCTION pm_guard_portfolio_record();
