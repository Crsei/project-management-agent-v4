import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceDiagnostic, maintenanceErrorReason, maintenanceFailureMessage } from './maintenance-diagnostics.mjs';

const secret = 'postgresql://desktop:secret-password@127.0.0.1/private-db C:\\private\\backup.sql private conversation';

test('maintenance diagnostics preserve fixed phase, reason and exit status without private errors', () => {
  const error = Object.assign(new Error(secret), { code: 'ENOSPC', detail: secret });
  const diagnostic = maintenanceDiagnostic({ operation: 'backup', phase: 'database-dump', reason: maintenanceErrorReason(error), exitCode: 1, detail: secret });
  assert.deepEqual(diagnostic, { operation: 'backup', phase: 'database-dump', reason: 'ENOSPC', exitCode: 1 });
  const message = maintenanceFailureMessage(JSON.stringify({ diagnostic, private: secret }), 'backup', 1, false);
  assert.match(message, /operation=backup; phase=database-dump; reason=ENOSPC; runtime-exit=1; command-exit=1/);
  assert.equal(message.includes(secret), false);
  assert.match(message, /cannot undo external side effects/);
});

test('maintenance diagnostics reject injected messages, arbitrary codes and malformed child output', () => {
  for (const output of [secret, JSON.stringify({ diagnostic: { operation: secret, phase: secret, reason: secret, exitCode: secret } }), 'null', '[]']) {
    const message = maintenanceFailureMessage(output, 'restore', 7, false);
    assert.match(message, /operation=restore; phase=runtime; reason=failed; runtime-exit=7; command-exit=unknown/);
    assert.equal(message.includes(secret), false);
  }
  assert.equal(maintenanceErrorReason(Object.assign(new Error(secret), { code: secret })), 'failed');
  assert.equal(maintenanceErrorReason(secret), 'failed');
  assert.equal(maintenanceDiagnostic({ exitCode: -1 }).exitCode, null);
  assert.match(maintenanceFailureMessage(secret, 'validate', null, true), /reason=output-limit; runtime-exit=unknown/);
});
