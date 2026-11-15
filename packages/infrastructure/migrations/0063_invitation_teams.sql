-- Team intent is organizational only; membership grants remain on the invitation.
ALTER TABLE member_invitations ADD COLUMN team_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE member_invitations ADD CONSTRAINT member_invitations_team_ids_valid
  CHECK (cardinality(team_ids) <= 100 AND array_position(team_ids, NULL) IS NULL);
