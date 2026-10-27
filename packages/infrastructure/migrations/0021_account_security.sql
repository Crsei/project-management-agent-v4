-- Account-global security facts are private to the authenticated user, not a workspace.
ALTER TABLE users ADD COLUMN credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0);
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_id_unique UNIQUE (id);

-- No password, password digest, session token/hash, arbitrary payload or request hash belongs here.
CREATE TABLE account_security_actions (
  user_id uuid NOT NULL REFERENCES users(id), action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('password_change', 'revoke_sessions')),
  status text NOT NULL CHECK (status IN ('committed', 'rejected', 'cancelled')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  revoked_count integer NOT NULL DEFAULT 0 CHECK (revoked_count >= 0),
  error_code text CHECK (error_code IN ('current_password_invalid', 'credential_version_conflict', 'not_found_or_forbidden', 'current_session_protected', 'password_unchanged')),
  http_status integer NOT NULL CHECK (http_status IN (200, 400, 403, 404, 409)),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, action_id),
  CHECK ((status = 'rejected' AND error_code IS NOT NULL AND http_status <> 200)
    OR (status <> 'rejected' AND error_code IS NULL AND http_status = 200))
);
CREATE FUNCTION pm_account_security_action_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account security actions are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER account_security_actions_immutable BEFORE UPDATE OR DELETE ON account_security_actions
  FOR EACH ROW EXECUTE FUNCTION pm_account_security_action_immutable();

-- Shared by API instances; counters survive failed authentication transactions and process restarts.
-- Keys are SHA-256 of purpose + normalized account/IP; no raw addresses or credentials are stored.
CREATE TABLE account_auth_limits (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX account_auth_limits_expiry_idx ON account_auth_limits (expires_at);
