-- Preserve existing 0052 rows. No directory ownership is inferred or backfilled.
ALTER TABLE workspace_sample_initializations
  ADD COLUMN core_root_identity jsonb,
  ADD COLUMN core_initialization_phase text NOT NULL DEFAULT 'unclaimed'
    CHECK (core_initialization_phase IN ('unclaimed', 'prestate', 'established')),
  ADD CONSTRAINT workspace_sample_core_claim CHECK (
    (core_initialization_phase = 'unclaimed' AND core_root_identity IS NULL)
    OR (core_initialization_phase IN ('prestate', 'established')
      AND core_root_identity IS NOT NULL
      AND jsonb_typeof(core_root_identity) = 'object'
      AND jsonb_typeof(core_root_identity->'device') = 'string'
      AND jsonb_typeof(core_root_identity->'inode') = 'string'
      AND core_root_identity->>'device' ~ '^\d+$'
      AND core_root_identity->>'inode' ~ '^\d+$'
      AND core_root_identity ?& ARRAY['device', 'inode']
      AND core_root_identity - 'device' - 'inode' = '{}'::jsonb)
  );
