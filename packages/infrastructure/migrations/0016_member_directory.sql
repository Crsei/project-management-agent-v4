-- Explicit opt-in: permit directory.read without broadening any existing grant.
ALTER TABLE memberships DROP CONSTRAINT memberships_capabilities_whitelist;
ALTER TABLE memberships ADD CONSTRAINT memberships_capabilities_whitelist CHECK (
  capabilities <@ ARRAY['domain.read','directory.read','audit.read','intent.propose','intent.decide','planning.edit','planning.lifecycle',
    'workitem.cancel_reopen','delivery.write','delivery.submit','delivery.review','workitem.complete','access.manage']::text[]
);

-- Profile fields share the existing global profile_version CAS and owner-only write.
ALTER TABLE users
  ADD COLUMN job_title text CHECK (job_title IS NULL OR length(btrim(job_title)) BETWEEN 1 AND 200),
  ADD COLUMN phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 80),
  ADD COLUMN avatar_data_url text CHECK (avatar_data_url IS NULL OR (
    octet_length(avatar_data_url) <= 349560
    AND avatar_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  ));
