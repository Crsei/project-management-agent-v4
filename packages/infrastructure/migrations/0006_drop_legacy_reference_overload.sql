-- Migration 0005 changed the project scope type to text, which created a new
-- pm_assert_reference overload instead of replacing the UUID-only one. Drop the
-- obsolete overload so references to core identities never attempt a UUID cast.
DROP FUNCTION IF EXISTS pm_assert_reference(uuid, uuid, text, text, boolean);
