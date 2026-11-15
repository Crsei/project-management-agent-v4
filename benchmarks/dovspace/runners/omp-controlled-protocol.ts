import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import { STANDARD_BODY } from '../pm-tools/corpus.ts';
import { runProtocolCalibration, type ProtocolCalibrationOptions, type ProtocolCalibrationResult } from './protocol-calibration.ts';

export type OmpControlledProtocolOptions = Omit<ProtocolCalibrationOptions, 'nativeOmp'>;
/** Real installed OMP + deterministic local HTTP provider, never a native RPC replacement. */
export async function runOmpControlledProtocol(options: OmpControlledProtocolOptions = {}): Promise<ProtocolCalibrationResult> {
  return runProtocolCalibration({ ...options, briefProbeBody: options.briefProbeBody ?? STANDARD_BODY, nativeOmp: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config: Partial<BenchmarkConfig> = {}, args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const value = args[index + 1];
      if (!value) throw new Error('Controlled OMP protocol flags require a value');
      if (args[index] === '--agent-image') config.agentImage = value;
      else if (args[index] === '--provider-binary') config.providerBinary = value;
      else if (args[index] === '--code-image') config.codeImage = value;
      else if (args[index] === '--outputs-root') config.outputsRoot = value;
      else if (args[index] === '--control-transport' && (value === 'http' || value === 'cli')) config.controlTransport = value;
      else throw new Error(`Unsupported controlled OMP option ${args[index]}`);
    }
    const result = await runOmpControlledProtocol({ config });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
