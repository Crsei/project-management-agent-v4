CREATE TABLE member_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email text NOT NULL CHECK (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK (role IN ('admin','member','guest')),
  project_ids text[],
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role<>'admin' OR project_ids IS NULL),
  CHECK (array_position(project_ids,NULL) IS NULL),
  CHECK ((status='accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
    OR (status<>'accepted' AND accepted_by IS NULL AND accepted_at IS NULL)),
  UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX member_invitations_active_email ON member_invitations(workspace_id,email) WHERE status='pending';
CREATE INDEX member_invitations_workspace ON member_invitations(workspace_id,created_at DESC,id);
CREATE TABLE invitation_mail_queue (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES member_invitations(id),
  generation integer NOT NULL CHECK (generation>0),
  token_ciphertext text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','smtp_accepted','failed','unknown','cancelled')),
  failure_code text CHECK (failure_code IN ('smtp_rejected','smtp_unavailable','smtp_configuration','send_outcome_unknown','send_lease_expired','token_unavailable')),
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='sending' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'sending' AND lease_id IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status='queued') = (token_ciphertext IS NOT NULL)),
  UNIQUE(invitation_id,generation)
);
CREATE INDEX invitation_mail_pending ON invitation_mail_queue(created_at,id) WHERE status='queued';
CREATE INDEX invitation_mail_expired_leases ON invitation_mail_queue(lease_expires_at) WHERE status='sending';
-- Only the acceptance outcome is durable. Credentials and raw invitation tokens never enter receipts.
CREATE TABLE invitation_acceptance_receipts (
  command_id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL UNIQUE REFERENCES member_invitations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  requested_name text,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
