-- Restore membership invariants that the 0005 type conversion had to drop.
ALTER TABLE memberships ADD CONSTRAINT memberships_capabilities_whitelist
  CHECK (capabilities <@ ARRAY['domain.read','intent.propose','intent.decide','planning.edit','planning.lifecycle','workitem.cancel_reopen','delivery.write','delivery.submit','delivery.review','workitem.complete','access.manage']::text[]);
ALTER TABLE memberships ADD CONSTRAINT memberships_access_scope_check
  CHECK (NOT ('access.manage'=ANY(capabilities)) OR project_ids IS NULL);
