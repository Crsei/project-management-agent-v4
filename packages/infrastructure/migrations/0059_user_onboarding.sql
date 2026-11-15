-- Existing accounts must not be enrolled automatically. New accounts use the defaults.
ALTER TABLE users
  ADD COLUMN onboarding_revision integer NOT NULL DEFAULT 0 CHECK (onboarding_revision >= 0),
  ADD COLUMN onboarding_workspace_id uuid,
  ADD COLUMN onboarding_profile text NOT NULL DEFAULT 'pending' CHECK (onboarding_profile IN ('pending','reviewed','skipped')),
  ADD COLUMN onboarding_ai text NOT NULL DEFAULT 'pending' CHECK (onboarding_ai IN ('pending','reviewed','skipped')),
  ADD COLUMN onboarding_completed_at timestamptz,
  ADD COLUMN onboarding_checklist_dismissed boolean NOT NULL DEFAULT false;
UPDATE users SET onboarding_completed_at = clock_timestamp(), onboarding_checklist_dismissed = true;
