-- Additive evidence only: old records retain unknown/missing linkage; never backfill by time or Session.
ALTER TABLE pm_agent_tool_operations
  ADD COLUMN target jsonb,
  ADD COLUMN recovery_identity jsonb,
  ADD COLUMN linkage jsonb,
  ADD COLUMN delegation_id uuid,
  ADD COLUMN outcome_evidence text CHECK (outcome_evidence IN ('pm_result','internal_proof'));
CREATE INDEX pm_agent_tool_operations_trace_idx ON pm_agent_tool_operations((linkage->>'traceId')) WHERE linkage IS NOT NULL;
CREATE INDEX pm_agent_tool_operations_command_idx ON pm_agent_tool_operations((recovery_identity->>'commandId')) WHERE recovery_identity IS NOT NULL;

-- Service request anti-replay state, not an execution/audit/permission system.
-- Retain nonces only through their signature lifetime; no business proof is expired here.
CREATE TABLE pm_agent_tool_service_nonces (
  nonce uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
