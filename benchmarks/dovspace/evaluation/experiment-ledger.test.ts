import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { benchmarkConfig } from '../benchmark.config.ts';
import { captureDigest, loadCaptureSigner, signCapture, type CaptureSigner, type TrustedCaptureKey } from './capture.ts';
import { runExperimentCommand } from './commands-experiment.ts';
import { closeExperimentLedger, createExperimentLedger, prepareExperimentAdmission, recordExperimentAdmission,
  recordExperimentSeal, verifyClosedExperimentLedger, type ExperimentLedgerAdmission, type ExperimentLedgerSeal, type PrepareExperimentAdmissionOptions } from './experiment-ledger.ts';
import { evaluationDigest, type EvaluationExperiment } from './review-schema.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const immutableBytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function experimentFixture(): EvaluationExperiment {
  const baseline = { arm: 'raw' as const, sourceState: 'committed-clean' as const, sourceSha: 'a'.repeat(40), productSha256: sha('baseline'), harnessSha256: sha('harness'), modelConfigSha256: sha('model'), toolPolicySha256: sha('tools') };
  const controls = { environmentSha256: sha('environment'), budgetSha256: sha('budget'), permissionsSha256: sha('permissions'),
    fixtureSemanticSha256: sha('fixture'), fixtureVersion: 'fixture-1', controlTransport: 'cli' as const };
  return { experimentId: 'signed-experiment', preregisteredAt: '2026-11-01T00:00:00.000Z',
    dataset: { datasetId: 'dataset-1', version: '1', digest: sha('dataset') }, baseline,
    candidate: { ...baseline, sourceSha: 'b'.repeat(40), productSha256: sha('candidate') }, treatment: 'productSha256',
    cells: (['baseline', 'candidate'] as const).map((variant, order) => ({ cellId: `${variant}-cell`, pairId: 'pair-1', cohort: 'critical',
      taskId: 'D01', taskVersion: 'task-1', arm: 'raw', variant, order: order as 0 | 1, requiredCriterionIds: ['code.feature', 'safety.permission'],
      requiredRequirementRevisions: ['req-1'], controls: { ...controls } })) };
}
async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, experiment: EvaluationExperiment = experimentFixture()) {
  const root = await mkdtemp(path.join(tmpdir(), 'experiment-ledger-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const keyDirectory = path.join(root, 'keys'); await mkdir(keyDirectory, { mode: 0o700 });
  async function key(seed: number, keyId: string) {
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey), privateKeyPath = path.join(keyDirectory, `${keyId}.pem`);
    await writeFile(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    const trusted: TrustedCaptureKey = { keyId, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      publicKeySha256: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex') };
    const signer = await loadCaptureSigner({ keyId, privateKeyPath, expectedPublicKeySha256: trusted.publicKeySha256 });
    return { signer, trusted, privateKeyPath };
  }
  const primary = await key(7, 'registered-key'), other = await key(8, 'other-key');
  const ledgerRoot = path.join(root, 'ledger');
  const descriptor = await createExperimentLedger({ ledgerRoot, experiment, trustedCaptureKey: primary.trusted, signer: primary.signer });
  function admission(index: number, variant: 'baseline' | 'candidate' = 'candidate'): ExperimentLedgerAdmission {
    // Deliberately non-schema key order: the recorded hash must preserve the actual runner's raw bytes.
    return { versions: { productSha256: experiment[variant].productSha256, harnessSha256: experiment[variant].harnessSha256,
      modelConfigSha256: experiment[variant].modelConfigSha256, toolPolicySha256: experiment[variant].toolPolicySha256,
      sourceState: experiment[variant].sourceState, sourceSha: experiment[variant].sourceSha,
      ...(experiment[variant].baseSourceSha ? { baseSourceSha: experiment[variant].baseSourceSha } : {}) },
      admittedAt: '2026-11-02T00:00:00.000Z', admissionId: `admission-${index}`, attemptId: `attempt-${index}`, runId: 'run-shared',
      taskId: 'D01', taskVersion: 'task-1', arm: experiment[variant].arm, dataset: { datasetId: experiment.dataset.datasetId, version: experiment.dataset.version, sha256: experiment.dataset.digest },
      evaluatorSha256: sha('evaluator'), fixtureVersion: 'fixture-1', controls: experiment.cells[0]!.controls };
  }
  function options(index: number, variant: 'baseline' | 'candidate' = 'candidate'): PrepareExperimentAdmissionOptions {
    return { ledgerRoot, signer: primary.signer, admission: admission(index, variant), cellId: `${variant}-cell`,
      member: { memberId: 'member-1', memberVersion: 1 }, archiveRoot: `archives/attempt-${index}` };
  }
  async function admitted(index: number, variant: 'baseline' | 'candidate' = 'candidate') {
    const input = options(index, variant), binding = await prepareExperimentAdmission(input);
    const finalAdmission = { ...(input.admission as ExperimentLedgerAdmission), experiment: binding };
    const admissionSha256 = sha(immutableBytes(finalAdmission));
    assert.deepEqual(await recordExperimentAdmission({ ...input, admission: finalAdmission, admissionSha256 }), binding);
    return { ...input, admission: finalAdmission, admissionSha256, binding };
  }
  function seal(index: number, status: 'succeeded' | 'failed' | 'interrupted' | 'incomplete' = 'succeeded') {
    return { ledgerRoot, signer: primary.signer, admissionId: `admission-${index}`, attemptId: `attempt-${index}`,
      manifestSha256: sha(`manifest-${index}`), gradeSha256: status === 'incomplete' ? null : sha(`grade-${index}`),
      captureAttestationSha256: sha(`capture-${index}`), status };
  }
  return { root, primary, other, experiment, ledgerRoot, descriptor, admission, options, admitted, seal };
}

type WorkerPhase = 'ready' | 'contending' | 'prepared' | 'recorded' | 'sealed' | 'denied' | 'held' | 'released';
interface LedgerProcessFixture {
  primary: { trusted: TrustedCaptureKey; privateKeyPath: string };
  options: (index: number) => PrepareExperimentAdmissionOptions;
  seal: (index: number) => { ledgerRoot: string; signer: CaptureSigner } & ExperimentLedgerSeal;
}
function ledgerProcess(t: { after: (cleanup: () => Promise<void>) => void }, f: LedgerProcessFixture, index: number, mode: 'admission' | 'guard' = 'admission') {
  const source = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { createHash } from 'node:crypto';
    import { constants } from 'node:fs';
    import { mkdir, open, rmdir } from 'node:fs/promises';
    import path from 'node:path';
    import { loadCaptureSigner } from ${JSON.stringify(new URL('./capture.ts', import.meta.url).href)};
    import { prepareExperimentAdmission, recordExperimentAdmission, recordExperimentSeal, closeExperimentLedger } from ${JSON.stringify(new URL('./experiment-ledger.ts', import.meta.url).href)};
    const receive = () => {
      const { promise, resolve } = Promise.withResolvers();
      process.once('message', resolve);
      return promise;
    };
    try {
      const input = await receive();
      if (input.mode === 'guard') {
        const handle = await open(input.options.ledgerRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const lock = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
        const completion = Promise.withResolvers();
        lock.once('error', completion.reject);
        lock.once('exit', completion.resolve);
        const code = await completion.promise;
        assert.equal(code, 0);
        await mkdir(path.join(input.options.ledgerRoot, '.writer'), { mode: 0o700 });
        await handle.sync();
        process.send('held');
        await receive();
        await rmdir(path.join(input.options.ledgerRoot, '.writer'));
        await handle.sync();
        await handle.close();
        process.send('released');
      } else {
        const signer = await loadCaptureSigner(input.captureKey), options = { ...input.options, signer };
        process.send('ready');
        await receive();
        const preparing = prepareExperimentAdmission(options);
        process.send('contending');
        const binding = await preparing;
        process.send('prepared');
        await receive();
        const admission = { ...options.admission, experiment: binding };
        const admissionSha256 = createHash('sha256').update(JSON.stringify(admission, null, 2) + '\\n').digest('hex');
        const recorded = { ...options, admission, admissionSha256 };
        await recordExperimentAdmission(recorded);
        process.send('recorded');
        await receive();
        const seal = { ...input.seal, signer };
        await recordExperimentSeal(seal);
        process.send('sealed');
        await receive();
        await assert.rejects(prepareExperimentAdmission(options), /closed/);
        await assert.rejects(recordExperimentAdmission(recorded), /closed/);
        await assert.rejects(recordExperimentSeal(seal), /closed/);
        await assert.rejects(closeExperimentLedger({ ledgerRoot: options.ledgerRoot, signer }), /closed/);
        process.send('denied');
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally { process.disconnect(); }
  `;
  const child = spawn(process.execPath, ['--conditions=development', '--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const completion = Promise.withResolvers<void>();
  const phases = new Map((['ready', 'contending', 'prepared', 'recorded', 'sealed', 'denied', 'held', 'released'] as const).map(phase => [phase, Promise.withResolvers<void>()]));
  const seen = new Set<WorkerPhase>();
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (value: string) => { stderr = (stderr + value).slice(-8192); });
  child.on('message', phase => { if (typeof phase === 'string' && phases.has(phase as WorkerPhase)) { seen.add(phase as WorkerPhase); phases.get(phase as WorkerPhase)!.resolve(); } });
  const failed = (error: Error) => { completion.reject(error); for (const phase of phases.values()) phase.reject(error); };
  child.once('error', failed);
  child.once('close', (code, signal) => {
    if (code === 0) completion.resolve();
    else failed(new Error(`Ledger worker failed (${code ?? signal}): ${stderr}`));
  });
  // A worker may fail before a later phase is awaited; retain its rejection for
  // that phase without creating an unrelated unhandled rejection.
  void completion.promise.catch(() => {});
  for (const phase of phases.values()) void phase.promise.catch(() => {});
  const { signer: _signer, ...options } = f.options(index), { signer: _sealSigner, ...seal } = f.seal(index);
  child.send({ mode, options, seal, captureKey: { keyId: f.primary.trusted.keyId, privateKeyPath: f.primary.privateKeyPath, expectedPublicKeySha256: f.primary.trusted.publicKeySha256 } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await completion.promise.catch(() => {}); });
  return { child, done: completion.promise, seen, phase: (name: WorkerPhase) => phases.get(name)!.promise, proceed: () => child.send('proceed') };
}

test('real deterministic Ed25519 chain retains retries, failures, unsealed and pending reservations in the denominator', async t => {
  const f = await fixture(t);
  const payload = { kind: 'ledger-deterministic-test', b: 2, a: 1 };
  assert.deepEqual(signCapture(f.primary.signer, payload), signCapture(f.primary.signer, { a: 1, kind: payload.kind, b: 2 }));
  assert.equal(f.descriptor.experimentSha256, evaluationDigest(f.experiment));
  const first = await f.admitted(1); await recordExperimentSeal(f.seal(1));
  const retry = await f.admitted(2); await recordExperimentSeal(f.seal(2, 'failed'));
  await f.admitted(3, 'baseline'); // A dispatch failure leaves the recorded admission unsealed.
  await prepareExperimentAdmission(f.options(4, 'baseline')); // A crash before dispatch remains pending.
  assert.notEqual(first.binding.sequence, retry.binding.sequence);
  const closed = await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  assert.deepEqual(closed.denominator, { allAdmissions: 4, recordedAdmissions: 3, sealedAdmissions: 2, pendingAdmissions: 1, unsealedAdmissions: 2, failedAdmissions: 1 });
  assert.deepEqual(closed.duplicateCells, ['baseline-cell', 'candidate-cell']);
  assert.deepEqual(closed.entries.map(entry => entry.admissionId), ['admission-1', 'admission-2', 'admission-3', 'admission-4']);
  assert.equal(closed.entries[1]!.seal!.status, 'failed');
  assert.equal(closed.entries[2]!.seal, null); assert.equal(closed.entries[3]!.admissionSha256, null);
  assert.equal(closed.entries[0]!.admissionSha256, first.admissionSha256);
  assert.equal(closed.closureSha256, captureDigest(closed.closure));
  const verified = await verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted, experimentSha256: f.descriptor.experimentSha256 });
  assert.deepEqual(verified, closed);
  const copiedRoot = path.join(f.root, 'portable-copy'); await cp(f.ledgerRoot, copiedRoot, { recursive: true });
  assert.deepEqual(await verifyClosedExperimentLedger({ ledgerRoot: copiedRoot, trustedCaptureKey: f.primary.trusted }), closed);
});

test('omitted, rewritten, reordered, appended and closure-rewritten entries are denied against the original independent key', async t => {
  const f = await fixture(t); await f.admitted(1); await recordExperimentSeal(f.seal(1));
  await f.admitted(2); await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  for (const mutation of ['omit-middle', 'omit-tail', 'rewrite', 'reorder', 'append', 'closure', 'experiment'] as const) {
    const copy = path.join(f.root, mutation); await cp(f.ledgerRoot, copy, { recursive: true });
    const entries = path.join(copy, 'entries'), names = (await readdir(entries)).sort();
    const first = path.join(entries, names[0]!), last = path.join(entries, names.at(-1)!);
    if (mutation === 'omit-middle') await rm(first);
    if (mutation === 'omit-tail') await rm(last);
    if (mutation === 'rewrite') {
      const changed = JSON.parse(await readFile(first, 'utf8'));
      changed.payload.event.data.admission.taskVersion = 'rewritten';
      await chmod(first, 0o600); await writeFile(first, immutableBytes(changed));
    }
    if (mutation === 'reorder') {
      const firstBytes = await readFile(first), lastBytes = await readFile(last);
      await chmod(first, 0o600); await chmod(last, 0o600);
      await writeFile(first, lastBytes); await writeFile(last, firstBytes);
    }
    if (mutation === 'append') await writeFile(path.join(entries, `${String(names.length + 1).padStart(10, '0')}.json`), await readFile(first), { mode: 0o400, flag: 'wx' });
    if (mutation === 'closure') {
      const file = path.join(copy, 'closure.json'), changed = JSON.parse(await readFile(file, 'utf8'));
      changed.payload.entryCount -= 1; await chmod(file, 0o600); await writeFile(file, immutableBytes(changed));
    }
    if (mutation === 'experiment') {
      const file = path.join(copy, 'experiment.json'), changed = JSON.parse(await readFile(file, 'utf8'));
      changed.dataset.version = 'rewritten'; await chmod(file, 0o600); await writeFile(file, immutableBytes(changed));
    }
    await assert.rejects(verifyClosedExperimentLedger({ ledgerRoot: copy, trustedCaptureKey: f.primary.trusted }), mutation);
  }
});

test('signer substitution, fake signer and exact experiment mismatch cannot acquire bundled trust', async t => {
  const f = await fixture(t);
  await assert.rejects(createExperimentLedger({ ledgerRoot: path.join(f.root, 'mismatch'), experiment: f.experiment, trustedCaptureKey: f.primary.trusted, signer: f.other.signer }));
  await assert.rejects(createExperimentLedger({ ledgerRoot: path.join(f.root, 'fake'), experiment: f.experiment, trustedCaptureKey: f.primary.trusted, signer: { ...f.primary.trusted } as CaptureSigner }));
  await assert.rejects(prepareExperimentAdmission({ ...f.options(1), signer: f.other.signer }));
  await f.admitted(1);
  await assert.rejects(recordExperimentSeal({ ...f.seal(1), signer: f.other.signer }));
  await assert.rejects(closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.other.signer }));
  await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  await assert.rejects(verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.other.trusted }));
  await assert.rejects(verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: { ...f.primary.trusted, keyId: 'unregistered-alias' } }));
  await assert.rejects(verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted, experimentSha256: sha('another-experiment') }), /experiment digest mismatch/);
});

test('admission binds exact task, dataset, cell, controls, version, member, archive and preregistration identities', async t => {
  const f = await fixture(t);
  const changes: Array<(input: PrepareExperimentAdmissionOptions) => void> = [
    input => { input.cellId = 'unregistered-cell'; },
    input => { (input.admission as ExperimentLedgerAdmission).taskId = 'K02'; },
    input => { (input.admission as ExperimentLedgerAdmission).taskVersion = 'other-task'; },
    input => { (input.admission as ExperimentLedgerAdmission).arm = 'knowledge'; },
    input => { (input.admission as ExperimentLedgerAdmission).dataset.sha256 = sha('other-dataset'); },
    input => { (input.admission as ExperimentLedgerAdmission).dataset.version = 'other-version'; },
    input => { (input.admission as ExperimentLedgerAdmission).dataset.datasetId = 'other-data'; },
    input => { (input.admission as ExperimentLedgerAdmission).versions.productSha256 = f.experiment.baseline.productSha256; },
    input => { (input.admission as ExperimentLedgerAdmission).versions.modelConfigSha256 = sha('other-model'); },
    input => { (input.admission as ExperimentLedgerAdmission).versions.sourceState = 'dirty-uncommitted'; },
    input => { (input.admission as ExperimentLedgerAdmission).versions.sourceSha = null; },
    input => { (input.admission as ExperimentLedgerAdmission).versions.baseSourceSha = 'd'.repeat(40); },
    input => { (input.admission as ExperimentLedgerAdmission).fixtureVersion = 'wrong-fixture'; },
    input => { (input.admission as ExperimentLedgerAdmission).controls = { ...f.experiment.cells[0]!.controls, budgetSha256: sha('wrong-budget') }; },
    input => { (input.admission as ExperimentLedgerAdmission).admittedAt = '2026-10-01T00:00:00.000Z'; },
  ];
  for (const change of changes) { const input = f.options(1); change(input); await assert.rejects(prepareExperimentAdmission(input)); }
  const input = f.options(1), binding = await prepareExperimentAdmission(input);
  const admission = { ...(input.admission as ExperimentLedgerAdmission), experiment: binding }, admissionSha256 = sha(immutableBytes(admission));
  await assert.rejects(recordExperimentAdmission({ ...input, admission, admissionSha256: sha('wrong-raw-bytes') }), /raw immutable JSON digest/);
  await assert.rejects(recordExperimentAdmission({ ...input, admission, admissionSha256, member: { ...input.member, memberVersion: 2 } }), /member/);
  await assert.rejects(recordExperimentAdmission({ ...input, admission, admissionSha256, archiveRoot: 'archives/other' }), /archive/);
  const forged = { ...admission, experiment: { ...binding, experimentSha256: sha('different-experiment') } };
  await assert.rejects(recordExperimentAdmission({ ...input, admission: forged, admissionSha256: sha(immutableBytes(forged)) }), /rewritten/);
  await recordExperimentAdmission({ ...input, admission, admissionSha256 });
  await assert.rejects(recordExperimentAdmission({ ...input, admission, admissionSha256 }), /already recorded/);
  await assert.rejects(prepareExperimentAdmission(input), /already exists/);
  await assert.rejects(prepareExperimentAdmission({ ...f.options(2), archiveRoot: input.archiveRoot }), /already exists/);
  await recordExperimentSeal(f.seal(1));
  await assert.rejects(recordExperimentSeal(f.seal(1)), /already sealed/);
});

test('serialized mutation lock preserves concurrent admissions and atomically excludes admission/seal after terminal close', async t => {
  const f = await fixture(t);
  const bindings = await Promise.all([prepareExperimentAdmission(f.options(1)), prepareExperimentAdmission(f.options(2))]);
  assert.deepEqual(bindings.map(binding => binding.sequence), [1, 2]);
  const input = f.options(1), admission = { ...(input.admission as ExperimentLedgerAdmission), experiment: bindings[0]! }, admissionSha256 = sha(immutableBytes(admission));
  await recordExperimentAdmission({ ...input, admission, admissionSha256 });
  await mkdir(path.join(f.ledgerRoot, '.writer'), { mode: 0o700 });
  await assert.rejects(prepareExperimentAdmission(f.options(3)), /lock is held/);
  await assert.rejects(recordExperimentSeal(f.seal(1)), /lock is held/);
  await assert.rejects(closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer }), /lock is held/);
  await rmdir(path.join(f.ledgerRoot, '.writer'));
  // Queue close first, then both mutation kinds without awaiting it. None may slip between snapshot and closure.
  const closing = closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  const lateAdmission = prepareExperimentAdmission(f.options(3)), lateSeal = recordExperimentSeal(f.seal(1));
  const outcomes = await Promise.allSettled([closing, lateAdmission, lateSeal]);
  assert.equal(outcomes[0]!.status, 'fulfilled'); assert.equal(outcomes[1]!.status, 'rejected'); assert.equal(outcomes[2]!.status, 'rejected');
  await assert.rejects(recordExperimentAdmission({ ...input, admission, admissionSha256 }), /closed/);
  await assert.rejects(closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer }), /closed/);
  const verified = await verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted });
  assert.equal(verified.denominator.allAdmissions, 2); assert.equal(verified.denominator.sealedAdmissions, 0);
  assert.equal(verified.entries[1]!.admissionSha256, null);
});

test('independent processes queue behind a live writer and preserve every signed admission/seal before irreversible closure', { timeout: 30_000 }, async t => {
  const f = await fixture(t), guard = ledgerProcess(t, f, 0, 'guard');
  await guard.phase('held');
  const workers = Array.from({ length: 6 }, (_, index) => ledgerProcess(t, f, index + 1));
  await Promise.all(workers.map(worker => worker.phase('ready')));
  for (const worker of workers) worker.proceed();
  await Promise.all(workers.map(worker => worker.phase('contending')));
  // Require observed kernel contention before releasing the guard. Linux 5.4
  // exposes only the first blocked waiter for this inode, not all six writers.
  const identity = await lstat(f.ledgerRoot, { bigint: true });
  const major = ((identity.dev >> 8n) & 0xfffn) | ((identity.dev >> 32n) & 0xfffff000n);
  const minor = (identity.dev & 0xffn) | ((identity.dev >> 12n) & 0xffffff00n);
  while (true) {
    t.signal.throwIfAborted();
    for (const worker of workers) if (worker.child.exitCode !== null || worker.child.signalCode !== null) await worker.done;
    const blocked = (await readFile('/proc/locks', 'utf8')).split('\n').some(line => {
      const match = /^\d+:\s+->\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s/.exec(line);
      return match !== null && BigInt(`0x${match[1]!}`) === major && BigInt(`0x${match[2]!}`) === minor && BigInt(match[3]!) === identity.ino;
    });
    if (blocked) break;
  }
  assert.ok(workers.every(worker => !worker.seen.has('prepared')));
  assert.deepEqual(await readdir(path.join(f.ledgerRoot, 'entries')), []);
  guard.proceed(); await guard.phase('released'); await guard.done;
  await Promise.all(workers.map(worker => worker.phase('prepared')));
  for (const worker of workers) worker.proceed();
  await Promise.all(workers.map(worker => worker.phase('recorded')));
  for (const worker of workers) worker.proceed();
  await Promise.all(workers.map(worker => worker.phase('sealed')));
  const closed = await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  assert.deepEqual(closed.denominator, { allAdmissions: 6, recordedAdmissions: 6, sealedAdmissions: 6, pendingAdmissions: 0, unsealedAdmissions: 0, failedAdmissions: 0 });
  assert.deepEqual(closed.entries.map(entry => entry.admissionId).sort(), Array.from({ length: 6 }, (_, index) => `admission-${index + 1}`));
  assert.equal(new Set(closed.entries.map(entry => entry.attemptId)).size, 6);
  assert.equal(closed.signedEvents.length, 18);
  assert.deepEqual(closed.entries.map(entry => entry.binding.sequence).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  for (const entry of closed.entries) {
    const expectedAdmission = { ...f.admission(Number(entry.admissionId.slice('admission-'.length))), experiment: entry.binding };
    assert.deepEqual(entry.admission, expectedAdmission);
    assert.equal(entry.admissionSha256, sha(immutableBytes(expectedAdmission)));
    assert.equal(entry.seal!.attemptId, entry.attemptId);
    assert.equal(entry.seal!.status, 'succeeded');
  }
  for (const worker of workers) worker.proceed();
  await Promise.all(workers.map(worker => worker.phase('denied')));
  await Promise.all(workers.map(worker => worker.done));
  assert.deepEqual(await verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted }), closed);
});

test('a crashed process leaves its durable mutation marker fail-closed after the kernel releases its mutex', { timeout: 15_000 }, async t => {
  const f = await fixture(t), owner = ledgerProcess(t, f, 0, 'guard');
  await owner.phase('held');
  const marker = path.join(f.ledgerRoot, '.writer'), before = await lstat(marker);
  owner.child.kill('SIGKILL');
  await assert.rejects(owner.done, /SIGKILL/);
  await assert.rejects(prepareExperimentAdmission(f.options(1)), /lock is held/);
  await assert.rejects(closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer }), /lock is held/);
  const after = await lstat(marker);
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  assert.deepEqual(await readdir(path.join(f.ledgerRoot, 'entries')), []);
});

test('unknown, foreign-content and unsafe mutation markers are never reclaimed or followed', async t => {
  const f = await fixture(t), marker = path.join(f.ledgerRoot, '.writer');
  const foreign = path.join(f.root, 'foreign-writer'); await mkdir(foreign, { mode: 0o700 });
  await writeFile(path.join(foreign, 'owner.json'), 'unrecognized-owner\\n', { mode: 0o600, flag: 'wx' });
  for (const kind of ['empty', 'foreign', 'file', 'symlink'] as const) {
    if (kind === 'empty' || kind === 'foreign') await mkdir(marker, { mode: 0o700 });
    if (kind === 'foreign') await writeFile(path.join(marker, 'owner.json'), 'unrecognized-owner\\n', { mode: 0o600, flag: 'wx' });
    if (kind === 'file') await writeFile(marker, 'unrecognized-owner\\n', { mode: 0o600, flag: 'wx' });
    if (kind === 'symlink') await symlink(foreign, marker);
    const before = await lstat(marker);
    await assert.rejects(prepareExperimentAdmission(f.options(1)), /lock is held/);
    await assert.rejects(recordExperimentSeal(f.seal(1)), /lock is held/);
    await assert.rejects(closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer }), /lock is held/);
    const after = await lstat(marker);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    assert.equal(await readFile(path.join(foreign, 'owner.json'), 'utf8'), 'unrecognized-owner\\n');
    assert.deepEqual(await readdir(path.join(f.ledgerRoot, 'entries')), []);
    await rm(marker, { recursive: true, force: true });
  }
});

test('offline experiment CLI reserves distinct receipt outputs and requires an explicit matching private key', async t => {
  const f = await fixture(t), root = path.join(benchmarkConfig.outputsRoot, `experiment-command-${randomUUID()}`);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const experimentPath = path.join(f.root, 'experiment-input.json'); await writeFile(experimentPath, immutableBytes(f.experiment), { mode: 0o600, flag: 'wx' });
  const inputPath = path.join(f.root, 'command-input.json'), ledgerRoot = path.join(root, 'ledger'), outputRoot = path.join(root, 'create-receipt');
  const input = { ledgerRoot, experimentPath, keyId: f.primary.trusted.keyId, privateKeyPath: f.primary.privateKeyPath, trustedCaptureKey: f.primary.trusted };
  await writeFile(inputPath, immutableBytes(input), { mode: 0o600, flag: 'wx' });
  assert.equal(await runExperimentCommand('unsupported', {}), undefined);
  await assert.rejects(runExperimentCommand('experiment-create', { input: inputPath, 'output-root': path.join(root, 'bad-flag'), registry: root }), /Unsupported/);
  await assert.rejects(runExperimentCommand('experiment-create', { input: inputPath, 'output-root': path.join(ledgerRoot, 'receipt') }), /nonoverlapping/);
  const created = await runExperimentCommand('experiment-create', { input: inputPath, 'output-root': outputRoot });
  assert.equal(created!.exitCode, 0);
  assert.ok(!(await readFile(path.join(outputRoot, 'result.json'), 'utf8')).includes(f.primary.privateKeyPath));
  await assert.rejects(runExperimentCommand('experiment-create', { input: inputPath, 'output-root': outputRoot }), /already exists/);
  const closePath = path.join(f.root, 'close-input.json');
  await writeFile(closePath, immutableBytes({ ledgerRoot, keyId: input.keyId, privateKeyPath: input.privateKeyPath }), { mode: 0o600, flag: 'wx' });
  const closed = await runExperimentCommand('experiment-close', { input: closePath, 'output-root': path.join(root, 'close-receipt') });
  assert.equal(closed!.exitCode, 0);
  assert.equal((await verifyClosedExperimentLedger({ ledgerRoot, trustedCaptureKey: f.primary.trusted })).denominator.allAdmissions, 0);
  const absentPath = path.join(f.root, 'absent-key.json');
  await writeFile(absentPath, immutableBytes({ ledgerRoot: path.join(root, 'missing-key-ledger'), experimentPath, keyId: input.keyId, trustedCaptureKey: input.trustedCaptureKey }), { mode: 0o600, flag: 'wx' });
  await assert.rejects(runExperimentCommand('experiment-create', { input: absentPath, 'output-root': path.join(root, 'missing-key-receipt') }));
});

test('arm-only experiment admits real matched identities without inventing a differing product or model hash', async t => {
  const experiment = experimentFixture();
  experiment.treatment = 'arm';
  experiment.candidate = { ...experiment.baseline, arm: 'dovspace' };
  for (const cell of experiment.cells) cell.arm = experiment[cell.variant].arm;
  const f = await fixture(t, experiment);
  const baseline = await f.admitted(1, 'baseline'), candidate = await f.admitted(2, 'candidate');
  assert.equal(baseline.admission.arm, 'raw');
  assert.equal(candidate.admission.arm, 'dovspace');
  assert.deepEqual(baseline.admission.versions, candidate.admission.versions);
  await recordExperimentSeal(f.seal(1));
  await recordExperimentSeal(f.seal(2));
  const closed = await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  assert.equal(closed.denominator.allAdmissions, 2);
  assert.deepEqual(closed.duplicateCells, []);
  assert.deepEqual((await verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted })).entries.map(entry => entry.admission.arm), ['raw', 'dovspace']);
});

test('offline dirty snapshot binds exact product bytes without fabricating a committed source revision', async t => {
  const experiment = experimentFixture();
  experiment.treatment = 'arm';
  experiment.baseline = { ...experiment.baseline, sourceState: 'dirty-uncommitted', sourceSha: null, baseSourceSha: 'a'.repeat(40) };
  experiment.candidate = { ...experiment.baseline, arm: 'dovspace' };
  for (const cell of experiment.cells) cell.arm = experiment[cell.variant].arm;
  const f = await fixture(t, experiment);
  const falseClean = f.options(3), falseAdmission = falseClean.admission as ExperimentLedgerAdmission;
  falseAdmission.versions.sourceState = 'committed-clean';
  falseAdmission.versions.sourceSha = 'a'.repeat(40);
  await assert.rejects(prepareExperimentAdmission(falseClean), /source revision|source state/);
  await f.admitted(1, 'baseline');
  await f.admitted(2, 'candidate');
  const closed = await closeExperimentLedger({ ledgerRoot: f.ledgerRoot, signer: f.primary.signer });
  const verified = await verifyClosedExperimentLedger({ ledgerRoot: f.ledgerRoot, trustedCaptureKey: f.primary.trusted });
  assert.deepEqual(verified, closed);
  for (const entry of verified.entries) {
    assert.equal(entry.admission.versions.sourceSha, null);
    assert.equal(entry.admission.versions.sourceState, 'dirty-uncommitted');
    assert.equal(entry.admission.versions.productSha256, experiment.baseline.productSha256);
  }
});
