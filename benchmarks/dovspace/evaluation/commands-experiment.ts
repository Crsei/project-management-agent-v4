import path from 'node:path';
import { z } from 'zod';
import { prepareReportDirectory } from '../reports/files.ts';
import { assertReservedOutput, safeEvidenceJson, writeImmutableJson } from './archive.ts';
import { CaptureKeySchema, loadCaptureSigner } from './capture.ts';
import { closeExperimentLedger, createExperimentLedger } from './experiment-ledger.ts';

export const EXPERIMENT_COMMAND_FLAGS: Record<string, readonly string[]> = {
  'experiment-create': ['input', 'output-root'], 'experiment-close': ['input', 'output-root'],
};
const KeyInputSchema = z.object({ ledgerRoot: z.string().min(1), keyId: z.string().min(1), privateKeyPath: z.string().min(1) }).strict();
const CreateInputSchema = KeyInputSchema.extend({ experimentPath: z.string().min(1), trustedCaptureKey: CaptureKeySchema }).strict();

/** Explicit host-held keys only. Receipts never contain private key paths or private key material. */
export async function runExperimentCommand(command: string, flags: Record<string, string>): Promise<{ exitCode: number; result: unknown } | undefined> {
  if (!Object.hasOwn(EXPERIMENT_COMMAND_FLAGS, command)) return undefined;
  for (const flag of Object.keys(flags)) if (!EXPERIMENT_COMMAND_FLAGS[command]!.includes(flag)) throw new Error(`Unsupported evaluation ${command} flag --${flag}`);
  if (!flags.input || !flags['output-root']) throw new Error(`${command} requires --input FILE --output-root DIR`);
  const input = await safeEvidenceJson(flags.input);
  const selection = command === 'experiment-create' ? CreateInputSchema.parse(input) : KeyInputSchema.parse(input);
  const ledgerRoot = assertReservedOutput(selection.ledgerRoot), outputRoot = assertReservedOutput(flags['output-root']);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (contains(ledgerRoot, outputRoot) || contains(outputRoot, ledgerRoot)) throw new Error('Ledger and receipt outputs must be separate nonoverlapping reserved directories');
  const create = command === 'experiment-create' ? CreateInputSchema.parse(input) : null;
  const signer = await loadCaptureSigner({ keyId: selection.keyId, privateKeyPath: selection.privateKeyPath,
    ...(create ? { expectedPublicKeySha256: create.trustedCaptureKey.publicKeySha256 } : {}) });
  const experiment = create ? await safeEvidenceJson(create.experimentPath) : null;
  // Reserve the receipt before mutating the ledger; retries cannot replace a prior operation's receipt.
  await prepareReportDirectory(outputRoot, true);
  let result: unknown;
  if (create) {
    const descriptor = await createExperimentLedger({ ledgerRoot, experiment, trustedCaptureKey: create.trustedCaptureKey, signer });
    result = { operation: 'experiment-create', descriptor, inferencePerformed: false, pmReplayPerformed: false };
  } else {
    const closed = await closeExperimentLedger({ ledgerRoot, signer });
    result = { operation: 'experiment-close', ledgerRoot, ledgerId: closed.ledgerId, experimentId: closed.experimentId,
      experimentSha256: closed.experimentSha256, closureSha256: closed.closureSha256, closedAt: closed.closedAt,
      denominator: closed.denominator, duplicateCells: closed.duplicateCells, inferencePerformed: false, pmReplayPerformed: false };
  }
  await writeImmutableJson(path.join(outputRoot, 'result.json'), result);
  return { exitCode: 0, result };
}
