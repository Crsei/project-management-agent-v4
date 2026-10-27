-- Presentation identity is independent of membership versions, stream cursors and core directories.
ALTER TABLE workspaces
  ADD COLUMN icon text NOT NULL DEFAULT 'building'
    CHECK (icon IN ('building','grid','briefcase','layers','rocket','globe')),
  ADD COLUMN color text NOT NULL DEFAULT '#2F2E2A'
    CHECK (color IN ('#2F2E2A','#5A67D8','#3B82C4','#23918A','#C54B78','#C48A1E')),
  ADD COLUMN identity_version integer NOT NULL DEFAULT 1 CHECK (identity_version > 0),
  ADD COLUMN identity_updated_at timestamptz;
UPDATE workspaces SET identity_updated_at=created_at;
ALTER TABLE workspaces ALTER COLUMN identity_updated_at SET DEFAULT now(), ALTER COLUMN identity_updated_at SET NOT NULL;
