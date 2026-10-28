import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRecoveryFixture } from './account-recovery-fixture.ts';
import { MailFixtureScope } from './mail-fixture-lifecycle.ts';
import { createInvitationFixture, createSmtpFixture } from './member-invitations-fixture.ts';

async function refusesConnection(port: number) {
  const socket = connect({ host: '127.0.0.1', port });
  try {
    const outcome = Promise.withResolvers<Error>();
    socket.once('error', outcome.resolve);
    socket.once('connect', () => outcome.reject(new Error('A closed fixture still accepts connections')));
    assert.equal((await outcome.promise as NodeJS.ErrnoException).code, 'ECONNREFUSED');
  } finally { socket.destroy(); }
}

describe('mail fixture cancellation and cleanup ownership', () => {
  it('rejects already canceled callers before acquiring any fixture resources', { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const reason = new Error('Canceled before initialization');
    controller.abort(reason);
    for (const create of [createRecoveryFixture, createInvitationFixture, createSmtpFixture]) {
      await assert.rejects(create({ signal: controller.signal }), error => error === reason);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('waits for a late real listener acquisition and closes it before cancellation settles', { timeout: 5000 }, async t => {
    const controller = new AbortController();
    const scope = new MailFixtureScope(controller.signal);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reason = new Error('Cancel while an acquisition cannot yet finish');
    let port = 0;
    let laterStage = false;
    t.after(async () => { release.resolve(); await scope.close(); });
    const initialization = scope.initialize(async () => {
      await scope.acquire(async () => {
        started.resolve();
        await release.promise;
        const smtp = await createSmtpFixture();
        port = smtp.config.port;
        return smtp;
      }, smtp => smtp.close());
      laterStage = true;
    });
    const rejected = assert.rejects(initialization, error => error === reason);
    await started.promise;
    controller.abort(reason);
    const closing = scope.close();
    assert.equal(scope.close(), closing);
    let closed = false;
    void closing.then(() => { closed = true; }, () => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, 'close must wait for the in-flight acquisition, not just mark closed');
    release.resolve();
    await rejected;
    await closing;
    assert.equal(laterStage, false);
    assert.ok(port > 0);
    await refusesConnection(port);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('owns the earliest temporary directory even when the next initialization stage fails', { timeout: 5000 }, async () => {
    const scope = new MailFixtureScope();
    const failure = new Error('Failure before the old fixture try block');
    let root = '';
    await assert.rejects(scope.initialize(async () => {
      root = await scope.acquire(() => mkdtemp(join(tmpdir(), 'pm-mail-partial-')), owned => rm(owned, { recursive: true, force: true }));
      throw failure;
    }), error => error === failure);
    await assert.rejects(stat(root), { code: 'ENOENT' });
    await scope.close();
  });

  it('shares close completion through cancellation during cleanup and attempts every disposer after failures', { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const scope = new MailFixtureScope(controller.signal);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const cleanupFailure = new Error('One owned resource failed to close');
    const disposed: string[] = [];
    await scope.initialize(async () => {
      scope.defer(() => { disposed.push('first'); });
      scope.defer(() => { disposed.push('failing'); throw cleanupFailure; });
      scope.defer(async () => { entered.resolve(); await finish.promise; disposed.push('last'); });
    });
    const closing = scope.close();
    const rejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(cleanupFailure));
    await entered.promise;
    controller.abort(new Error('Cancellation while cleanup is running'));
    assert.equal(scope.close(), closing);
    assert.deepEqual(disposed, []);
    finish.resolve();
    await rejected;
    assert.deepEqual(disposed, ['last', 'failing', 'first']);
    assert.equal(scope.close(), closing, 'Repeated calls must retain even a failed cleanup completion');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('closes real SMTP peers and the listener once even for concurrent close calls', { timeout: 5000 }, async t => {
    const smtp = await createSmtpFixture({ signal: t.signal });
    t.after(() => smtp.close());
    const socket = connect({ host: smtp.config.host, port: smtp.config.port });
    t.after(() => { socket.destroy(); });
    await once(socket, 'data');
    const peerClosed = once(socket, 'close');
    const closing = smtp.close();
    assert.equal(smtp.close(), closing);
    await closing;
    await peerClosed;
    await refusesConnection(smtp.config.port);
  });
});
