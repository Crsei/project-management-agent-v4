import { encode, sha256 } from './io.mjs';
import { file, makeDirectory, publish } from './supplemental-fs.mjs';

const fingerprint = (path, value) => ({ path, sha256: sha256(value.bytes), bytes: value.bytes.length, mode: value.mode });
const matches = (value, expected) => value && sha256(value.bytes) === expected.sha256 && value.bytes.length === expected.bytes && value.mode === expected.mode;

export async function stageExact(root, name, bytes, mode = 0o644) {
  const current = await file(root, name, { optional: true });
  if (current) {
    if (!current.bytes.equals(bytes) || current.mode !== (mode === 0o600 ? 0o644 : mode)) throw new Error(`STALE_SUPPLEMENTAL_STAGE: ${name}`);
  } else await publish(root, name, bytes, mode, { exclusive: true });
}

export function requiresReconstruction(error) {
  return error?.code === 'ENOENT' || /UNSAFE_(?:PATH|TREE)|UNAPPROVED_SNAPSHOT_CHANGE|CONCURRENT_SUPPLEMENTAL_WRITE|STALE_CANDIDATE(?:$|_)|STALE_TRANSACTION_CONTROL_STATE|preexisting inode preserved at|SUPPLEMENTAL_RECONSTRUCTION_REQUIRED/.test(error?.message ?? '');
}

/**
 * External journal + exact pre/post images precede every candidate mutation.
 * Caller holds the external single-writer lock. Same-receipt recovery supports
 * only complete identifiable pre/post layouts, not every process-crash window.
 * Missing leaves, extra backup/temp names, nlink residue or third bytes require
 * fresh candidate/control reconstruction while preserving all existing inodes.
 * Neither callbacks nor commands can come from JSON/candidate inputs.
 */
export async function applyTransaction({ candidate, control, inputReceipt, preparedState, nextState, plannedFiles, preimages, validate }) {
  const preparedBytes = encode(preparedState), nextBytes = encode(nextState);
  if (sha256(preparedBytes) !== inputReceipt) throw new Error('STALE_PREPARED_CONTROL_RECEIPT');
  const files = plannedFiles.map(entry => {
    const before = preimages.get(entry.path);
    if (!before) throw new Error(`MISSING_TRANSACTION_PREIMAGE: ${entry.path}`);
    if (sha256(entry.content) !== entry.sha256 || entry.content.length !== entry.bytes) throw new Error(`INVALID_TRANSACTION_POSTIMAGE: ${entry.path}`);
    return { path: entry.path, before: fingerprint(entry.path, before), after: { path: entry.path, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode } };
  });
  const receipt = { version: 1, kind: 'supplemental-ui-forward-recoverable-transaction', inputReceipt, nextReceipt: sha256(nextBytes), files };
  const journalBytes = encode(receipt), written = [];
  const priorJournal = await file(control, 'transaction/manifest.json', { optional: true });
  await makeDirectory(`${control}/transaction`);
  await stageExact(control, 'transaction/prepared-state.json', preparedBytes, 0o600);
  await stageExact(control, 'transaction/next-state.json', nextBytes, 0o600);
  for (let index = 0; index < files.length; index++) {
    await stageExact(control, `transaction/pre-${index}`, preimages.get(files[index].path).bytes, files[index].before.mode);
    await stageExact(control, `transaction/post-${index}`, plannedFiles[index].content, files[index].after.mode);
  }
  await stageExact(control, 'transaction/manifest.json', journalBytes, 0o600);
  let currentState, currentReceipt;
  try {
    currentState = await file(control, 'state.json');
    currentReceipt = sha256(currentState.bytes);
    if (![inputReceipt, receipt.nextReceipt].includes(currentReceipt)) throw new Error('STALE_TRANSACTION_CONTROL_STATE');
    await validate('before');
    // Preflight every target before the first write, including resume mixtures.
    for (const entry of files) {
      const current = await file(candidate, entry.path);
      if (!matches(current, entry.before) && !matches(current, entry.after)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${entry.path}`);
    }
    for (let index = 0; index < files.length; index++) {
      const entry = files[index], current = await file(candidate, entry.path);
      if (matches(current, entry.after)) continue;
      if (!matches(current, entry.before)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${entry.path}`);
      await publish(candidate, entry.path, plannedFiles[index].content, entry.after.mode, { expected: entry.before });
      written.push(entry.path);
    }
    await validate('after');
    for (const entry of files) if (!matches(await file(candidate, entry.path), entry.after)) throw new Error(`CONCURRENT_SUPPLEMENTAL_WRITE: ${entry.path}`);
    if (currentReceipt === inputReceipt) await publish(control, 'state.json', nextBytes, 0o600, { expected: fingerprint('state.json', currentState) });
    return { controlSha256: receipt.nextReceipt, writtenPaths: written, recovered: Boolean(priorJournal), transaction: `${control}/transaction/manifest.json` };
  } catch (error) {
    const unidentifiedPaths = [];
    for (const entry of files) {
      try {
        const current = await file(candidate, entry.path, { optional: true });
        if (!matches(current, entry.before) && !matches(current, entry.after)) unidentifiedPaths.push(entry.path);
      } catch { unidentifiedPaths.push(entry.path); }
    }
    try {
      const state = await file(control, 'state.json', { optional: true });
      if (!state || ![inputReceipt, receipt.nextReceipt].includes(sha256(state.bytes))) unidentifiedPaths.push('external control/state.json');
    } catch { unidentifiedPaths.push('external control/state.json'); }
    const reconstruction = requiresReconstruction(error) || unidentifiedPaths.length > 0;
    const code = reconstruction ? 'SUPPLEMENTAL_RECONSTRUCTION_REQUIRED' : 'SUPPLEMENTAL_TRANSACTION_PENDING';
    const instruction = reconstruction
      ? 'Unidentified layout/control state: preserve every backup/temp/inode and the journal; do not retry or auto-clean this candidate. Create NEW candidate/control from the independent preimage plus explicitly reviewed feature outputs and record again.'
      : 'Exact pre/post images retained. SAME-receipt forward retry is supported only while every path/control state is a complete identifiable pre/post and no backup/temp/nlink residue exists, after restoring reviewed prerequisites; this is not universal process-crash recovery.';
    const failure = new Error(`${code}: ${control}/transaction/manifest.json; writtenThisAttempt=${JSON.stringify(written)}; unidentifiedPaths=${JSON.stringify(unidentifiedPaths)}; ${instruction} Cause: ${error.message}`, { cause: error });
    failure.code = code;
    failure.details = { transaction: `${control}/transaction/manifest.json`, writtenPaths: written, unidentifiedPaths, recovery: reconstruction ? 'fresh-candidate-and-control-required' : 'complete-pre-post-only' };
    throw failure;
  }
}
