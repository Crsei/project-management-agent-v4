import { parseArgs } from 'node:util';
import { EVIDENCE_COMMAND_FLAGS, runEvidenceCommand } from './commands-evidence.ts';
import { DATASET_COMMANDS, DATASET_COMMAND_FLAGS, runDatasetCommand } from './commands-dataset.ts';
import { REVIEW_COMMAND_FLAGS, runReviewCommand } from './commands-review.ts';

const commands: Record<string, readonly string[]> = {
  ...EVIDENCE_COMMAND_FLAGS,
  ...Object.fromEntries(DATASET_COMMANDS.map(command => [command, DATASET_COMMAND_FLAGS])),
  ...REVIEW_COMMAND_FLAGS,
};

export const EVALUATION_HELP = `Dovspace evaluation — explicit offline evidence and feedback operations

Usage: bench evaluation COMMAND --input FILE --output-root DIR [command flags]

${Object.entries(commands).map(([command, flags]) => `  ${command}: ${flags.map(flag => `--${flag}`).join(' ')}`).join('\n')}

Input schemas and command-specific required flags are validated before use.
Use private JSON inputs and fresh directories under benchmarks/dovspace/outputs.
Dataset commands require a separate private --registry directory.
Regrade runs declared graders, not the Agent; it never replays PM operations.
A partial/not-evaluable grade exits 2; a blocked release decision exits 1.
Hashes prove byte identity, not authorization. Synthetic evidence is not model quality.
No command enables production sampling, performs inference or publishes a release.
`;

export async function runEvaluationCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    if (rest.length) throw new Error('Unexpected arguments after evaluation help');
    console.log(EVALUATION_HELP);
    return 0;
  }
  if (!Object.hasOwn(commands, command)) throw new Error('Unknown evaluation command; use evaluation --help');
  const parsed = parseArgs({ args: rest, strict: true, allowPositionals: false,
    options: Object.fromEntries(commands[command]!.map(flag => [flag, { type: 'string' as const }])) });
  // Duplicate options are rejected rather than silently selecting a different input or registry.
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2).split('=')[0]!;
    if (seen.has(name)) throw new Error('Duplicate evaluation option');
    seen.add(name);
    if (!argument.includes('=')) index++;
  }
  const flags = parsed.values as Record<string, string>;
  const result = await runEvidenceCommand(command, flags)
    ?? await runDatasetCommand(command, flags)
    ?? await runReviewCommand(command, flags);
  if (!result) throw new Error('Evaluation command has no registered handler');
  console.log(JSON.stringify(result.result, null, 2));
  return result.exitCode;
}
