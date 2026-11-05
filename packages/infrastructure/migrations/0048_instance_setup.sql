-- No seed row: deployment preparation creates the only pending record.
-- Completion is retained independently of account/workspace deletion or restore.
CREATE TABLE instance_setup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token_hash text,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((completed_at IS NULL AND token_hash IS NOT NULL AND token_hash ~ '^[a-f0-9]{64}$')
      OR (completed_at IS NOT NULL AND token_hash IS NULL))
);
