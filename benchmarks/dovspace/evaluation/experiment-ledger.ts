import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prepareReportDirectory } from '../reports/files.ts';
import { ArmSchema } from '../schemas/types.ts';
import { CaptureKeySchema, captureDigest, signCapture, verifyCaptureAttestation, type CaptureAttestation, type CaptureSigner, type TrustedCaptureKey } from './capture.ts';
import { evaluationDigest, ExperimentSchema, type EvaluationExperiment } from './review-schema.ts';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const Instant = z.iso.datetime();
const BindingSchema = z.object({ experimentId: Identifier, experimentSha256: Digest, ledgerId: Identifier, cellId: Identifier,
  pairId: Identifier, variant: z.enum(['baseline', 'candidate']), order: z.union([z.literal(0), z.literal(1)]),
  memberId: Identifier, memberVersion: z.number().int().positive(), sequence: z.number().int().positive() }).strict();
export type ExperimentAdmissionBinding = z.infer<typeof BindingSchema>;
const AdmissionSchema = z.object({ admissionId: Identifier, attemptId: Identifier, runId: Identifier, taskId: Identifier,
  taskVersion: Identifier, arm: ArmSchema, admittedAt: Instant, dataset: z.object({ datasetId: Identifier, version: Identifier, sha256: Digest }).strict(),
  evaluatorSha256: Digest, versions: z.object({ productSha256: Digest, harnessSha256: Digest, modelConfigSha256: Digest,
    toolPolicySha256: Digest, sourceSha: z.string().regex(/^[a-f0-9]{40}$/).nullable().optional(),
    sourceState: z.enum(['committed-clean', 'dirty-uncommitted']).optional(), baseSourceSha: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict(),
  experiment: BindingSchema.optional(), fixtureVersion: Identifier.optional() }).passthrough();
export type ExperimentLedgerAdmission = z.infer<typeof AdmissionSchema>;
const MemberSchema = z.object({ memberId: Identifier, memberVersion: z.number().int().positive() }).strict();
const ArchiveReference = z.string().min(1).max(4096).refine(value => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127 || code === 92) return false;
  }
  return path.isAbsolute(value) || value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}, 'Canonical archive reference required');
const DescriptorSchema = z.object({ schemaVersion: z.literal(1), experimentId: Identifier, experimentSha256: Digest,
  preregisteredAt: Instant, trustedCaptureKey: CaptureKeySchema, ledgerId: Identifier, ledgerRoot: z.string().min(1) }).strict();
export type ExperimentLedgerDescriptor = z.infer<typeof DescriptorSchema>;
const SetupSchema = z.object({ kind: z.literal('experiment-ledger-setup'), descriptor: DescriptorSchema, experiment: ExperimentSchema }).strict();
const PrepareSchema = z.object({ binding: BindingSchema, admission: AdmissionSchema, archiveRoot: ArchiveReference }).strict();
const AdmissionRecordSchema = z.object({ admissionId: Identifier, attemptId: Identifier, binding: BindingSchema,
  admission: AdmissionSchema, admissionJson: z.string().min(1), admissionSha256: Digest }).strict();
const SealSchema = z.object({ admissionId: Identifier, attemptId: Identifier, manifestSha256: Digest, gradeSha256: Digest.nullable(),
  captureAttestationSha256: Digest, status: z.enum(['succeeded', 'failed', 'interrupted', 'incomplete']) }).strict();
export type ExperimentLedgerSeal = z.infer<typeof SealSchema>;
const EventSchema = z.object({ kind: z.literal('experiment-ledger-entry'), ledgerId: Identifier, experimentSha256: Digest,
  sequence: z.number().int().positive(), previousEntrySha256: Digest, recordedAt: Instant,
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('prepare'), data: PrepareSchema }).strict(),
    z.object({ type: z.literal('admission'), data: AdmissionRecordSchema }).strict(),
    z.object({ type: z.literal('seal'), data: SealSchema }).strict(),
  ]) }).strict();
type LedgerEvent = z.infer<typeof EventSchema>;
export interface ExperimentLedgerEntry {
  admissionId: string; attemptId: string; runId: string; binding: ExperimentAdmissionBinding;
  admission: ExperimentLedgerAdmission; archiveRoot: string; admissionSha256: string | null; seal: ExperimentLedgerSeal | null;
}
const DenominatorSchema = z.object({ allAdmissions: z.number().int().nonnegative(), recordedAdmissions: z.number().int().nonnegative(),
  sealedAdmissions: z.number().int().nonnegative(), pendingAdmissions: z.number().int().nonnegative(),
  unsealedAdmissions: z.number().int().nonnegative(), failedAdmissions: z.number().int().nonnegative() }).strict();
const ClosureSchema = z.object({ kind: z.literal('experiment-ledger-closure'), ledgerId: Identifier, experimentId: Identifier,
  experimentSha256: Digest, setupSha256: Digest, closedAt: Instant, entryCount: z.number().int().nonnegative(),
  chainHeadSha256: Digest, entrySha256s: z.array(Digest), admissionIds: z.array(Identifier), entriesSha256: Digest,
  denominator: DenominatorSchema, duplicateCells: z.array(Identifier) }).strict();
export interface ClosedExperimentLedger extends ExperimentLedgerDescriptor {
  experiment: EvaluationExperiment; entries: ExperimentLedgerEntry[]; signedEvents: CaptureAttestation[];
  closure: CaptureAttestation; closureSha256: string; closedAt: string;
  denominator: z.infer<typeof DenominatorSchema>; duplicateCells: string[];
}
interface LedgerState {
  descriptor: ExperimentLedgerDescriptor; experiment: EvaluationExperiment; setupSha256: string;
  entries: ExperimentLedgerEntry[]; signedEvents: CaptureAttestation[]; entrySha256s: string[];
}
export interface PrepareExperimentAdmissionOptions {
  ledgerRoot: string; signer: CaptureSigner; admission: unknown; cellId: string;
  member: { memberId: string; memberVersion: number }; archiveRoot: string;
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  captureDigest(value); // Reject values outside the capture canonical JSON contract before persistence.
  return JSON.stringify(canonical(value)) + '\n';
}
function bytesDigest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function withoutBinding(admission: ExperimentLedgerAdmission): Omit<ExperimentLedgerAdmission, 'experiment'> {
  const { experiment: _binding, ...body } = admission;
  return body;
}
function same(left: unknown, right: unknown): boolean { return captureDigest(left) === captureDigest(right); }
async function privateDirectory(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await realpath(root) !== root) throw new Error('Ledger directory must be private, canonical and unredirected');
}
async function immutableJson(filename: string, value: unknown): Promise<void> {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(canonicalJson(value)); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function privateBytes(filename: string): Promise<Buffer> {
  if (await realpath(path.dirname(filename)) !== path.dirname(filename)) throw new Error('Ledger file has a redirected ancestor');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > 64 * 1024 * 1024) throw new Error('Ledger file must be bounded, private and single-link');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Ledger changed during read');
    return bytes;
  } finally { await handle.close(); }
}
function decode(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('Malformed experiment ledger JSON (content withheld)'); }
}
async function exists(filename: string): Promise<boolean> {
  return await lstat(filename).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
}
function assertSigner(signer: CaptureSigner, trusted: TrustedCaptureKey): void {
  // The capture module rejects forged structural signers; this additionally pins the registered key identity.
  const probe = signCapture(signer, { kind: 'experiment-ledger-signer-check', keyId: trusted.keyId });
  verifyCaptureAttestation(probe, trusted, { kind: 'experiment-ledger-signer-check', keyId: trusted.keyId });
}
const writerQueues = new Map<string, Promise<void>>();
async function writerMutex(root: string): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new Error('Experiment ledger serialization requires Linux util-linux flock');
  await privateDirectory(root);
  // Reuse the repository's inherited-FD flock protocol. The canonical root inode
  // is stable: never create, unlink or replace a separate kernel-lock file.
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || (identity.mode & 0o077) !== 0 || identity.uid !== process.geteuid?.()) throw new Error('Experiment ledger mutex directory ownership is unsafe');
    const child = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
    const completion = Promise.withResolvers<number | null>();
    child.once('error', () => completion.resolve(-1));
    child.once('exit', code => completion.resolve(code));
    if (await completion.promise !== 0) throw new Error('Experiment ledger mutex unavailable; Linux util-linux flock is required');
    await privateDirectory(root);
    const current = await lstat(root);
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Experiment ledger mutex directory changed during acquisition');
    return handle; // The shared open-file description retains the kernel lock.
  } catch (error) { await handle.close(); throw error; }
}
async function releaseWriterMarker(lock: string, marker: FileHandle, mutex: FileHandle): Promise<void> {
  const owned = await marker.stat(), actual = await lstat(lock);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== owned.dev || actual.ino !== owned.ino) throw new Error('Experiment ledger mutation lock ownership changed; reconcile the prior writer');
  await rmdir(lock);
  await mutex.sync();
}
/** Live writers queue in the kernel; a surviving .writer marker always fails closed. */
async function locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = writerQueues.get(root) ?? Promise.resolve();
  const { promise: current, resolve: release } = Promise.withResolvers<void>();
  writerQueues.set(root, current);
  await previous;
  const lock = path.join(root, '.writer');
  let mutex: FileHandle | undefined, marker: FileHandle | undefined;
  try {
    mutex = await writerMutex(root);
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Experiment ledger mutation lock is held; reconcile the prior writer'); throw error; }
    marker = await open(lock, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    // Persist the crash marker before any admission, seal or closure mutation.
    await mutex.sync();
    return await operation();
  } finally {
    try {
      if (marker) await releaseWriterMarker(lock, marker, mutex!);
    } finally {
      try { await marker?.close(); }
      finally {
        try { await mutex?.close(); }
        finally { if (writerQueues.get(root) === current) writerQueues.delete(root); release(); }
      }
    }
  }
}
function assertAdmission(state: Pick<LedgerState, 'descriptor' | 'experiment'>, admission: ExperimentLedgerAdmission, cellId: string): EvaluationExperiment['cells'][number] {
  const cell = state.experiment.cells.find(item => item.cellId === cellId);
  if (!cell) throw new Error('Admission cell is not in the exact registered experiment');
  if (admission.taskId !== cell.taskId || admission.taskVersion !== cell.taskVersion) throw new Error('Admission task/version differs from the registered cell');
  if (!same(admission.dataset, { datasetId: state.experiment.dataset.datasetId, version: state.experiment.dataset.version, sha256: state.experiment.dataset.digest })) throw new Error('Admission dataset differs from the registered experiment');
  const identity = state.experiment[cell.variant];
  if (admission.arm !== cell.arm || admission.arm !== identity.arm) throw new Error('Admission arm differs from the exact registered cell/variant');
  for (const key of ['productSha256', 'harnessSha256', 'modelConfigSha256', 'toolPolicySha256'] as const) {
    if (admission.versions[key] !== identity[key]) throw new Error(`Admission ${key} differs from the exact registered variant`);
  }
  if (admission.versions.sourceSha !== undefined && admission.versions.sourceSha !== identity.sourceSha) throw new Error('Admission source revision differs from the registered variant');
  if (admission.versions.sourceState !== undefined && admission.versions.sourceState !== identity.sourceState) throw new Error('Admission source state differs from the registered variant');
  if (admission.versions.baseSourceSha !== undefined && admission.versions.baseSourceSha !== identity.baseSourceSha) throw new Error('Admission base source revision differs from the registered variant');
  if (admission.fixtureVersion !== undefined && admission.fixtureVersion !== cell.controls.fixtureVersion) throw new Error('Admission fixture differs from the registered controls');
  if (admission.controls !== undefined && !same(admission.controls, cell.controls)) throw new Error('Admission controls differ from preregistration');
  if (Date.parse(admission.admittedAt) < Date.parse(state.descriptor.preregisteredAt)) throw new Error('Admission predates experiment preregistration');
  return cell;
}
function bindingFor(state: Pick<LedgerState, 'descriptor' | 'experiment'>, admission: ExperimentLedgerAdmission, cellId: string,
  member: z.infer<typeof MemberSchema>, sequence: number): ExperimentAdmissionBinding {
  const cell = assertAdmission(state, admission, cellId);
  return { experimentId: state.descriptor.experimentId, experimentSha256: state.descriptor.experimentSha256, ledgerId: state.descriptor.ledgerId,
    cellId, pairId: cell.pairId, variant: cell.variant, order: cell.order, ...member, sequence };
}
function summarize(entries: ExperimentLedgerEntry[]): { denominator: z.infer<typeof DenominatorSchema>; duplicateCells: string[] } {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.binding.cellId, (counts.get(entry.binding.cellId) ?? 0) + 1);
  return { denominator: { allAdmissions: entries.length, recordedAdmissions: entries.filter(entry => entry.admissionSha256 !== null).length,
    sealedAdmissions: entries.filter(entry => entry.seal !== null).length, pendingAdmissions: entries.filter(entry => entry.admissionSha256 === null).length,
    unsealedAdmissions: entries.filter(entry => entry.seal === null).length, failedAdmissions: entries.filter(entry => entry.seal !== null && entry.seal.status !== 'succeeded').length },
    duplicateCells: [...counts].filter(([, count]) => count > 1).map(([cell]) => cell).sort() };
}
function applyEvent(state: LedgerState, payload: LedgerEvent): void {
  const { event } = payload;
  if (event.type === 'prepare') {
    const { admission, binding, archiveRoot } = event.data;
    const expected = bindingFor(state, admission, binding.cellId, { memberId: binding.memberId, memberVersion: binding.memberVersion }, payload.sequence);
    if (!same(binding, expected) || admission.experiment !== undefined) throw new Error('Invalid prepared admission binding');
    if (state.entries.some(entry => entry.admissionId === admission.admissionId || entry.attemptId === admission.attemptId || entry.archiveRoot === archiveRoot)) throw new Error('Admission, attempt or archive identity already exists; retries require separate immutable entries');
    state.entries.push({ admissionId: admission.admissionId, attemptId: admission.attemptId, runId: admission.runId,
      binding, admission, archiveRoot, admissionSha256: null, seal: null });
    return;
  }
  const entry = state.entries.find(item => item.admissionId === event.data.admissionId);
  if (!entry || entry.attemptId !== event.data.attemptId) throw new Error('Ledger event does not match a prepared admission/attempt');
  if (event.type === 'admission') {
    const data = event.data;
    if (entry.admissionSha256 !== null || entry.seal !== null || !same(data.binding, entry.binding)
      || !same(data.admission.experiment, entry.binding) || !same(withoutBinding(data.admission), entry.admission)) throw new Error('Admission was already recorded or its prepared identity was rewritten');
    // The runner writes exactly this immutable representation before model dispatch.
    if (!same(decode(Buffer.from(data.admissionJson)), data.admission) || bytesDigest(data.admissionJson) !== data.admissionSha256) throw new Error('Admission raw immutable JSON digest differs');
    entry.admission = data.admission; entry.admissionSha256 = data.admissionSha256;
  } else {
    if (entry.admissionSha256 === null || entry.seal !== null) throw new Error('Cannot seal an unrecorded or already sealed admission');
    entry.seal = event.data;
  }
}
async function readState(root: string, trustedCaptureKey: TrustedCaptureKey): Promise<LedgerState> {
  await privateDirectory(root);
  const setupInput = decode(await privateBytes(path.join(root, 'setup.json')));
  const setup = SetupSchema.parse(verifyCaptureAttestation(setupInput, trustedCaptureKey));
  if (!same(setup.descriptor.trustedCaptureKey, trustedCaptureKey) || setup.descriptor.experimentId !== setup.experiment.experimentId
    || setup.descriptor.preregisteredAt !== setup.experiment.preregisteredAt || setup.descriptor.experimentSha256 !== evaluationDigest(setup.experiment)) throw new Error('Signed experiment setup identity differs');
  const experiment = ExperimentSchema.parse(decode(await privateBytes(path.join(root, 'experiment.json'))));
  if (!same(experiment, setup.experiment)) throw new Error('Immutable source experiment manifest was rewritten');
  const state: LedgerState = { descriptor: setup.descriptor, experiment, setupSha256: captureDigest(setupInput), entries: [], signedEvents: [], entrySha256s: [] };
  const directory = path.join(root, 'entries');
  await privateDirectory(directory);
  for (const name of (await readdir(directory)).sort()) {
    if (name !== `${String(state.signedEvents.length + 1).padStart(10, '0')}.json`) throw new Error('Ledger entries were omitted, reordered or renamed');
    const signedInput = decode(await privateBytes(path.join(directory, name)));
    const payload = EventSchema.parse(verifyCaptureAttestation(signedInput, trustedCaptureKey));
    if (payload.ledgerId !== state.descriptor.ledgerId || payload.experimentSha256 !== state.descriptor.experimentSha256
      || payload.sequence !== state.signedEvents.length + 1 || payload.previousEntrySha256 !== (state.entrySha256s.at(-1) ?? state.setupSha256)
      || Date.parse(payload.recordedAt) < Date.parse(state.descriptor.preregisteredAt)) throw new Error('Ledger event signature chain, sequence or experiment identity differs');
    applyEvent(state, payload);
    state.signedEvents.push(signedInput as CaptureAttestation); state.entrySha256s.push(captureDigest(signedInput));
  }
  return state;
}
async function openState(root: string, signer: CaptureSigner): Promise<LedgerState> {
  if (await exists(path.join(root, 'closure.json'))) throw new Error('Experiment ledger is closed; all subsequent mutations are denied');
  const trusted: TrustedCaptureKey = { keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, publicKeySha256: signer.publicKeySha256 };
  assertSigner(signer, trusted);
  const state = await readState(root, trusted);
  assertSigner(signer, state.descriptor.trustedCaptureKey);
  return state;
}
async function append(root: string, state: LedgerState, signer: CaptureSigner, event: LedgerEvent['event']): Promise<void> {
  const payload: LedgerEvent = { kind: 'experiment-ledger-entry', ledgerId: state.descriptor.ledgerId,
    experimentSha256: state.descriptor.experimentSha256, sequence: state.signedEvents.length + 1,
    previousEntrySha256: state.entrySha256s.at(-1) ?? state.setupSha256, recordedAt: new Date().toISOString(), event };
  EventSchema.parse(payload);
  applyEvent(state, payload);
  const signed = signCapture(signer, payload);
  await immutableJson(path.join(root, 'entries', `${String(payload.sequence).padStart(10, '0')}.json`), signed);
  state.signedEvents.push(signed); state.entrySha256s.push(captureDigest(signed));
}

/** Copies and signs canonical preregistration before any attempt may be admitted. */
export async function createExperimentLedger(options: { ledgerRoot: string; experiment: unknown; trustedCaptureKey: TrustedCaptureKey; signer: CaptureSigner }): Promise<ExperimentLedgerDescriptor> {
  const experiment = ExperimentSchema.parse(options.experiment), trustedCaptureKey = CaptureKeySchema.parse(options.trustedCaptureKey);
  assertSigner(options.signer, trustedCaptureKey);
  if (Date.parse(experiment.preregisteredAt) > Date.now()) throw new Error('Experiment preregistration cannot be in the future');
  const root = path.resolve(options.ledgerRoot);
  const descriptor: ExperimentLedgerDescriptor = { schemaVersion: 1, experimentId: experiment.experimentId,
    experimentSha256: evaluationDigest(experiment), preregisteredAt: experiment.preregisteredAt, trustedCaptureKey,
    ledgerId: `ledger-${randomUUID()}`, ledgerRoot: root };
  const signed = signCapture(options.signer, { kind: 'experiment-ledger-setup', descriptor, experiment });
  await prepareReportDirectory(root, true);
  await privateDirectory(root);
  await mkdir(path.join(root, 'entries'), { mode: 0o700 });
  await immutableJson(path.join(root, 'experiment.json'), experiment);
  await immutableJson(path.join(root, 'setup.json'), signed);
  return descriptor;
}

/** Reservation is already part of the denominator if the runner crashes before recording or dispatch. */
export async function prepareExperimentAdmission(options: PrepareExperimentAdmissionOptions): Promise<ExperimentAdmissionBinding> {
  const root = path.resolve(options.ledgerRoot), admission = AdmissionSchema.parse(decode(Buffer.from(canonicalJson(options.admission))));
  if (admission.experiment !== undefined) throw new Error('Prepare admission before adding its experiment binding');
  const member = MemberSchema.parse(options.member), archiveRoot = ArchiveReference.parse(options.archiveRoot), cellId = Identifier.parse(options.cellId);
  return locked(root, async () => {
    const state = await openState(root, options.signer);
    const binding = bindingFor(state, admission, cellId, member, state.signedEvents.length + 1);
    await append(root, state, options.signer, { type: 'prepare', data: { binding, admission, archiveRoot } });
    return binding;
  });
}

/** Must resolve before model dispatch. The supplied hash is of the runner's immutable pretty JSON bytes. */
export async function recordExperimentAdmission(options: PrepareExperimentAdmissionOptions & { admissionSha256: string }): Promise<ExperimentAdmissionBinding> {
  captureDigest(options.admission);
  const admissionJson = JSON.stringify(options.admission, null, 2) + '\n';
  const root = path.resolve(options.ledgerRoot), admission = AdmissionSchema.parse(decode(Buffer.from(admissionJson))), member = MemberSchema.parse(options.member);
  const admissionSha256 = Digest.parse(options.admissionSha256), archiveRoot = ArchiveReference.parse(options.archiveRoot), cellId = Identifier.parse(options.cellId);
  return locked(root, async () => {
    const state = await openState(root, options.signer), entry = state.entries.find(item => item.admissionId === admission.admissionId);
    if (!entry) throw new Error('Prepare experiment admission before recording its signed binding');
    assertAdmission(state, admission, cellId);
    if (entry.archiveRoot !== archiveRoot || entry.binding.cellId !== cellId || entry.binding.memberId !== member.memberId || entry.binding.memberVersion !== member.memberVersion) throw new Error('Admission cell, dataset member or archive reference differs from its reservation');
    await append(root, state, options.signer, { type: 'admission', data: { admissionId: admission.admissionId, attemptId: admission.attemptId,
      binding: entry.binding, admission, admissionJson, admissionSha256 } });
    return entry.binding;
  });
}

export async function recordExperimentSeal(options: { ledgerRoot: string; signer: CaptureSigner } & ExperimentLedgerSeal): Promise<void> {
  const root = path.resolve(options.ledgerRoot), { ledgerRoot: _root, signer: _signer, ...input } = options;
  const seal = SealSchema.parse(input);
  await locked(root, async () => { const state = await openState(root, options.signer); await append(root, state, options.signer, { type: 'seal', data: seal }); });
}

/** Closure and all writers share one lock; publishing closure is the irreversible terminal boundary. */
export async function closeExperimentLedger(options: { ledgerRoot: string; signer: CaptureSigner }): Promise<ClosedExperimentLedger> {
  const root = path.resolve(options.ledgerRoot);
  return locked(root, async () => {
    const state = await openState(root, options.signer), summary = summarize(state.entries);
    const payload = ClosureSchema.parse({ kind: 'experiment-ledger-closure', ledgerId: state.descriptor.ledgerId,
      experimentId: state.descriptor.experimentId, experimentSha256: state.descriptor.experimentSha256, setupSha256: state.setupSha256,
      closedAt: new Date().toISOString(), entryCount: state.signedEvents.length,
      chainHeadSha256: state.entrySha256s.at(-1) ?? state.setupSha256, entrySha256s: state.entrySha256s,
      admissionIds: state.entries.map(entry => entry.admissionId), entriesSha256: captureDigest(state.entries), ...summary });
    const closure = signCapture(options.signer, payload);
    await immutableJson(path.join(root, 'closure.json'), closure);
    return { ...state.descriptor, experiment: state.experiment, entries: state.entries, signedEvents: state.signedEvents,
      closure, closureSha256: captureDigest(closure), closedAt: payload.closedAt, ...summary };
  });
}

/** Only the caller's independently registered key supplies authority; the bundled descriptor never does. */
export async function verifyClosedExperimentLedger(options: { ledgerRoot: string; trustedCaptureKey: TrustedCaptureKey; experimentSha256?: string }): Promise<ClosedExperimentLedger> {
  const root = path.resolve(options.ledgerRoot), trusted = CaptureKeySchema.parse(options.trustedCaptureKey);
  await privateDirectory(root);
  if (await exists(path.join(root, '.writer'))) throw new Error('Cannot verify experiment ledger while a mutation lock is held');
  const names = (await readdir(root)).sort();
  if (!same(names, ['closure.json', 'entries', 'experiment.json', 'setup.json'])) throw new Error('Closed experiment ledger has unexpected or missing files');
  const closureInput = decode(await privateBytes(path.join(root, 'closure.json')));
  const payload = ClosureSchema.parse(verifyCaptureAttestation(closureInput, trusted));
  const state = await readState(root, trusted), summary = summarize(state.entries);
  if (options.experimentSha256 !== undefined && state.descriptor.experimentSha256 !== options.experimentSha256) throw new Error('Exact experiment digest mismatch');
  if (payload.ledgerId !== state.descriptor.ledgerId || payload.experimentId !== state.descriptor.experimentId
    || payload.experimentSha256 !== state.descriptor.experimentSha256 || payload.setupSha256 !== state.setupSha256
    || payload.entryCount !== state.signedEvents.length || payload.chainHeadSha256 !== (state.entrySha256s.at(-1) ?? state.setupSha256)
    || !same(payload.entrySha256s, state.entrySha256s) || !same(payload.admissionIds, state.entries.map(entry => entry.admissionId))
    || payload.entriesSha256 !== captureDigest(state.entries) || !same(payload.denominator, summary.denominator)
    || !same(payload.duplicateCells, summary.duplicateCells) || Date.parse(payload.closedAt) < Date.parse(state.descriptor.preregisteredAt)
    || state.signedEvents.some(signed => Date.parse(EventSchema.parse(signed.payload).recordedAt) > Date.parse(payload.closedAt))) throw new Error('Ledger closure does not preserve the exact signed admission population');
  return { ...state.descriptor, experiment: state.experiment, entries: state.entries, signedEvents: state.signedEvents,
    closure: closureInput as CaptureAttestation, closureSha256: captureDigest(closureInput), closedAt: payload.closedAt, ...summary };
}
