-- No historical address or invitation is a verification fact.
ALTER TABLE users ADD COLUMN recovery_email text UNIQUE;
ALTER TABLE users ADD COLUMN recovery_email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN recovery_email_version integer NOT NULL DEFAULT 1 CHECK (recovery_email_version > 0);
ALTER TABLE users ADD CONSTRAINT users_recovery_email_verified CHECK ((recovery_email IS NULL) = (recovery_email_verified_at IS NULL));
ALTER TABLE users ADD CONSTRAINT users_recovery_email_normalized CHECK (recovery_email IS NULL OR (recovery_email=lower(btrim(recovery_email)) AND length(recovery_email) BETWEEN 3 AND 254));
ALTER TABLE account_security_actions ADD COLUMN recovery_email_version integer NOT NULL DEFAULT 1 CHECK (recovery_email_version > 0);
ALTER TABLE account_security_actions ADD COLUMN challenge_id uuid;
ALTER TABLE account_security_actions DROP CONSTRAINT account_security_actions_kind_check;
ALTER TABLE account_security_actions ADD CONSTRAINT account_security_actions_kind_check CHECK (kind IN ('password_change','revoke_sessions','recovery_email_begin','recovery_email_confirm','recovery_email_cancel','recovery_email_unbind'));
ALTER TABLE account_security_actions DROP CONSTRAINT account_security_actions_error_code_check;
ALTER TABLE account_security_actions ADD CONSTRAINT account_security_actions_error_code_check CHECK (error_code IN ('current_password_invalid','credential_version_conflict','not_found_or_forbidden','current_session_protected','password_unchanged','recovery_email_version_conflict','recovery_email_pending','recovery_email_conflict','recovery_link_unavailable','recovery_email_not_registered','recovery_delivery_in_progress'));

CREATE TABLE account_recovery_tokens (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK (purpose IN ('verify_recovery_email','reset_password')),
 token_hash text UNIQUE NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'), candidate_email text,
 credential_version integer NOT NULL CHECK (credential_version>0), recovery_email_version integer NOT NULL CHECK (recovery_email_version>0),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','revoked','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, consumed_at timestamptz,
 UNIQUE(id,purpose),
 CHECK (expires_at>created_at), CHECK ((status='consumed')=(consumed_at IS NOT NULL)),
 CHECK ((purpose='verify_recovery_email' AND candidate_email IS NOT NULL AND candidate_email=lower(btrim(candidate_email)) AND length(candidate_email) BETWEEN 3 AND 254) OR (purpose='reset_password' AND candidate_email IS NULL))
);
CREATE UNIQUE INDEX account_recovery_tokens_active_unique ON account_recovery_tokens(user_id,purpose) WHERE status='active';
CREATE INDEX account_recovery_tokens_user_idx ON account_recovery_tokens(user_id);
CREATE FUNCTION pm_account_recovery_token_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery token history is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'active' OR NEW.status='active' OR (to_jsonb(NEW)-'status'-'consumed_at')<>(to_jsonb(OLD)-'status'-'consumed_at') THEN
  RAISE EXCEPTION 'invalid recovery token transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_recovery_token_transition BEFORE UPDATE OR DELETE ON account_recovery_tokens FOR EACH ROW EXECUTE FUNCTION pm_account_recovery_token_transition();
CREATE TABLE account_recovery_mail_queue (
 id uuid PRIMARY KEY, token_id uuid NOT NULL UNIQUE REFERENCES account_recovery_tokens(id), purpose text NOT NULL CHECK (purpose IN ('verify_recovery_email','reset_password')),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','smtp_accepted','failed','unknown','cancelled')),
 token_ciphertext text, lease_id uuid, lease_expires_at timestamptz,
 failure_code text CHECK (failure_code IN ('smtp_rejected','smtp_configuration','smtp_unavailable','send_outcome_unknown','send_lease_expired','token_unavailable')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(token_id,purpose) REFERENCES account_recovery_tokens(id,purpose),
 CHECK ((status='queued')=(token_ciphertext IS NOT NULL)), CHECK ((status='sending')=(lease_id IS NOT NULL)), CHECK ((status='sending')=(lease_expires_at IS NOT NULL)),
 CHECK ((status IN ('failed','unknown'))=(failure_code IS NOT NULL))
);
CREATE INDEX account_recovery_mail_queued_idx ON account_recovery_mail_queue(created_at,id) WHERE status='queued';
CREATE FUNCTION pm_account_recovery_mail_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery delivery history is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status NOT IN ('queued','sending') OR NEW.id<>OLD.id OR NEW.token_id<>OLD.token_id OR NEW.purpose<>OLD.purpose OR NEW.created_at<>OLD.created_at
 OR (OLD.status='queued' AND NEW.status NOT IN ('sending','cancelled')) OR (OLD.status='sending' AND NEW.status NOT IN ('smtp_accepted','failed','unknown')) THEN
  RAISE EXCEPTION 'invalid recovery delivery transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_recovery_mail_transition BEFORE UPDATE OR DELETE ON account_recovery_mail_queue FOR EACH ROW EXECUTE FUNCTION pm_account_recovery_mail_transition();
CREATE TABLE account_recovery_requests (
 request_id uuid PRIMARY KEY, address_key text CHECK (address_key ~ '^[a-f0-9]{64}$'), token_id uuid REFERENCES account_recovery_tokens(id),
 status text NOT NULL CHECK (status IN ('accepted','cancelled')), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((status='accepted' AND address_key IS NOT NULL) OR (status='cancelled' AND address_key IS NULL AND token_id IS NULL))
);
CREATE TRIGGER account_recovery_requests_immutable BEFORE UPDATE OR DELETE ON account_recovery_requests FOR EACH ROW EXECUTE FUNCTION pm_account_security_action_immutable();
CREATE TABLE account_password_reset_actions (
 token_id uuid NOT NULL REFERENCES account_recovery_tokens(id), action_id uuid NOT NULL UNIQUE, status text NOT NULL CHECK (status IN ('committed','rejected','cancelled')),
 credential_version_after integer CHECK (credential_version_after>0), revoked_count integer NOT NULL DEFAULT 0 CHECK (revoked_count>=0),
 error_code text CHECK (error_code IN ('recovery_link_unavailable','password_unchanged')), http_status integer NOT NULL CHECK (http_status IN (200,400,409)),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(token_id,action_id),
 CHECK ((status='rejected' AND error_code IS NOT NULL AND http_status<>200 AND credential_version_after IS NULL) OR (status='committed' AND error_code IS NULL AND http_status=200 AND credential_version_after IS NOT NULL) OR (status='cancelled' AND error_code IS NULL AND http_status=200 AND credential_version_after IS NULL))
);
CREATE TRIGGER account_password_reset_actions_immutable BEFORE UPDATE OR DELETE ON account_password_reset_actions FOR EACH ROW EXECUTE FUNCTION pm_account_security_action_immutable();
-- User-row writes already hold the common login/change/logout lock. This also covers
-- instance maintenance disabling an account; no asynchronous invalidation is trusted.
CREATE FUNCTION pm_invalidate_account_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.credential_version<>OLD.credential_version OR NEW.recovery_email_version<>OLD.recovery_email_version OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
  UPDATE account_recovery_tokens SET status='revoked' WHERE user_id=NEW.id AND status='active';
  UPDATE account_recovery_mail_queue q SET status='cancelled',token_ciphertext=NULL,updated_at=clock_timestamp() FROM account_recovery_tokens t WHERE q.token_id=t.id AND t.user_id=NEW.id AND q.status='queued';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_invalidate_account_recovery AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pm_invalidate_account_recovery();
