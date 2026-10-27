-- Confidence is an explicit manual assessment, independent of health status or task progress.
-- Missing legacy fields remain unknown; historical rows are never backfilled or rewritten.
ALTER TABLE dashboard_records
  ADD CONSTRAINT dashboard_portfolio_confidence CHECK (
    kind NOT IN ('portfolio_health', 'portfolio_health_assessment')
    OR NOT (data ? 'confidence')
    OR data->'confidence' = 'null'::jsonb
    OR (jsonb_typeof(data->'confidence') = 'string' AND data->>'confidence' IN ('high', 'medium', 'low'))
  );
