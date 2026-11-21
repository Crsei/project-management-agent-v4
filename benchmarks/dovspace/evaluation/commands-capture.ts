import path from 'node:path';
import { z } from 'zod';
import { prepareReportDirectory, readReportJson } from '../reports/files.ts';
import { assertReservedOutput, writeImmutableJson } from './archive.ts';
import { CaptureKeyOptionsSchema, CaptureKeySchema, generateCaptureKey } from './capture.ts';

export const CAPTURE_COMMAND_FLAGS: Record<string, readonly string[]> = { 'capture-keygen': ['input', 'output-root'] };
const keygenInput = z.object({ keyId: CaptureKeySchema.shape.keyId, keyDirectory: z.string().min(1) }).strict();

/** Key setup only. There is intentionally no submitted-payload signing command. */
export async function runCaptureCommand(command: string, flags: Record<string, string>): Promise<{ exitCode: number; result: unknown } | undefined> {
  if (!Object.hasOwn(CAPTURE_COMMAND_FLAGS, command)) return undefined;
  for (const name of Object.keys(flags)) if (!CAPTURE_COMMAND_FLAGS[command]!.includes(name)) throw new Error(`Unsupported evaluation ${command} flag --${name}`);
  if (!flags.input) throw new Error('Missing --input');
  if (!flags['output-root']) throw new Error('Missing --output-root');
  const input = keygenInput.parse(await readReportJson(flags.input));
  const outputRoot = assertReservedOutput(flags['output-root']);
  await prepareReportDirectory(outputRoot, true);
  const descriptor = await generateCaptureKey(input);
  const captureKeyPath = path.join(outputRoot, 'capture-key-options.json'), publicKeyPath = path.join(outputRoot, 'capture-public-key.json');
  const keyOptions = CaptureKeyOptionsSchema.parse({ keyId: descriptor.keyId, privateKeyPath: descriptor.privateKeyPath, expectedPublicKeySha256: descriptor.publicKeySha256 });
  const publicKey = CaptureKeySchema.parse({ keyId: descriptor.keyId, publicKeyPem: descriptor.publicKeyPem, publicKeySha256: descriptor.publicKeySha256 });
  await writeImmutableJson(captureKeyPath, keyOptions);
  await writeImmutableJson(publicKeyPath, publicKey);
  const result = { operation: 'capture-keygen', ...descriptor, captureKeyPath, publicKeyPath, inferencePerformed: false };
  await writeImmutableJson(path.join(outputRoot, 'capture-key.json'), result);
  return { exitCode: 0, result };
}
