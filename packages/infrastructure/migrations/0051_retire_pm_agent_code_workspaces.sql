-- Agent execution directories and chat scratch are now Agent-owned metadata.
-- Deployment must back up the retired registrations before applying this migration.
-- Do not cascade: a remaining dependency must stop retirement rather than delete
-- PM business definitions, execution snapshots, receipts or any other history.
-- Dropping these rows never removes, moves or recreates filesystem directories.
DROP TABLE IF EXISTS agent_code_workspaces;
DROP TABLE IF EXISTS agent_chat_scratch;
