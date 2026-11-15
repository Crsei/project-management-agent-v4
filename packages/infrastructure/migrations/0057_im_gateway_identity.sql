-- Gateway identity is part of the external account mapping. It does not grant PM access.
-- Existing rows retain the default identity; operators can keep it or configure a stable name.
ALTER TABLE im_identities
  ADD COLUMN gateway_id text NOT NULL DEFAULT 'default'
  CHECK (gateway_id ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
ALTER TABLE im_identities
  DROP CONSTRAINT im_identities_platform_bot_self_id_platform_user_id_key;
ALTER TABLE im_identities
  ADD CONSTRAINT im_identities_gateway_platform_bot_user_key UNIQUE (gateway_id, platform, bot_self_id, platform_user_id);
