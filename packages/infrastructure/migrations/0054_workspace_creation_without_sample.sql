-- Workspace creation may opt out of the built-in Nova sample. A skipped row is
-- already complete, so it never appears as a pending initialization or resumes
-- filesystem work; the same (actor_id, request_key) uniqueness still makes the
-- original creation intent idempotent across both modes.
ALTER TABLE workspace_sample_initializations
  DROP CONSTRAINT IF EXISTS workspace_sample_initializations_check,
  ADD COLUMN sample_skipped boolean NOT NULL DEFAULT false,
  ALTER COLUMN template DROP NOT NULL,
  ADD CONSTRAINT workspace_sample_initializations_creation_check CHECK (
    (status = 'pending'
      AND completed_at IS NULL
      AND project_id IS NULL
      AND sample_skipped = false
      AND template IS NOT NULL)
    OR (status = 'ready'
      AND completed_at IS NOT NULL
      AND (
        (sample_skipped = true AND project_id IS NULL AND template IS NULL)
        OR (sample_skipped = false AND project_id IS NOT NULL AND template IS NOT NULL)
      ))
  );
