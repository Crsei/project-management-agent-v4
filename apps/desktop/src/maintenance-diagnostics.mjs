// This is the entire diagnostic vocabulary allowed across the private child boundary.
// Never serialize error messages, stacks, command arguments, paths or SQL details.
const operations = new Set(['backup', 'restore', 'validate']);
const phases = new Set(['request', 'runtime', 'stopped-clients', 'project-export', 'database-dump', 'database-clone', 'blob-export', 'chat-copy', 'agent-backup', 'manifest', 'backup-validation', 'dump-validation', 'project-restore', 'agent-restore', 'database-restore', 'database-migrate', 'blob-restore', 'area-rebind', 'bootstrap', 'cleanup']);
const reasons = new Set(['failed', 'command-start', 'command-failed', 'output-limit', 'active-clients', 'monitor-mismatch', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '42501', '53100', '53200', '53300', '57P01', '08006']);

/** @param {unknown} value */
export function maintenanceDiagnostic(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    operation: 'operation' in input && operations.has(input.operation) ? input.operation : 'unknown',
    phase: 'phase' in input && phases.has(input.phase) ? input.phase : 'runtime',
    reason: 'reason' in input && reasons.has(input.reason) ? input.reason : 'failed',
    exitCode: 'exitCode' in input && Number.isSafeInteger(input.exitCode) && input.exitCode >= 0 && input.exitCode <= 0xffffffff ? input.exitCode : null,
  };
}

/** @param {unknown} error */
export function maintenanceErrorReason(error) {
  return error && typeof error === 'object' && 'code' in error && reasons.has(error.code) ? error.code : 'failed';
}

/** @param {string} output @param {string} operation @param {number | null} exitCode @param {boolean} overflow */
export function maintenanceFailureMessage(output, operation, exitCode, overflow) {
  let detail;
  try { detail = JSON.parse(output)?.diagnostic; } catch { /* Raw output is never diagnostic text. */ }
  const safe = maintenanceDiagnostic(detail);
  const expected = maintenanceDiagnostic({ operation });
  return `Desktop maintenance did not complete (operation=${expected.operation}; phase=${safe.phase}; reason=${overflow ? 'output-limit' : safe.reason}; runtime-exit=${Number.isSafeInteger(exitCode) ? exitCode : 'unknown'}; command-exit=${safe.exitCode ?? 'unknown'}). Review the trusted backup, runtime version and available disk space before retrying. New-target cleanup cannot undo external side effects of supplied SQL.`;
}
