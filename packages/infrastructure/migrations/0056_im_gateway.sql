-- IM identity and delivery facts only. No task/project/notification authority is copied here.
-- One Satori bot account can bind one active PM workspace in v1; revoked rows may be rebound.
CREATE TABLE im_link_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX im_link_codes_owner ON im_link_codes(workspace_id, user_id, created_at DESC);

CREATE TABLE im_link_attempts (
  platform text NOT NULL,
  bot_self_id text NOT NULL,
  platform_user_id text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ok boolean NOT NULL
);
CREATE INDEX im_link_attempts_window ON im_link_attempts(platform, bot_self_id, platform_user_id, attempted_at DESC);

CREATE TABLE im_identities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  platform text NOT NULL,
  bot_self_id text NOT NULL,
  platform_user_id text NOT NULL,
  platform_user_name text,
  reply_channel_id text NOT NULL,
  default_project_id text,
  notify_enabled boolean NOT NULL DEFAULT false,
  notification_cursor bigint NOT NULL DEFAULT 0 CHECK (notification_cursor >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (platform, bot_self_id, platform_user_id)
);
CREATE INDEX im_identities_user ON im_identities(workspace_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE im_delivery_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  binding_id uuid NOT NULL REFERENCES im_identities(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('reply', 'notification')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 300),
  payload text NOT NULL CHECK (length(payload) BETWEEN 1 AND 8000),
  project_id text,
  task_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'accepted', 'unknown', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  UNIQUE (binding_id, source_kind, source_id)
);
CREATE INDEX im_delivery_due ON im_delivery_jobs(next_attempt_at) WHERE state IN ('pending', 'sending');
CREATE INDEX im_delivery_binding ON im_delivery_jobs(binding_id, created_at);
