-- Cross-store work is deliberately not one SQL transaction. Unknown items retain
-- the original command identity and can only be reconciled against its receipt.
CREATE TABLE member_handovers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  user_id uuid NOT NULL REFERENCES users(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  items jsonb NOT NULL CHECK(jsonb_typeof(items) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, id),
  CHECK(user_id <> recipient_id)
);
CREATE INDEX member_handovers_actor ON member_handovers(workspace_id,actor_id,user_id,created_at);
