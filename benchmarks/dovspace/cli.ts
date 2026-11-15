import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBenchmarkConfig, repositoryRoot } from './benchmark.config.ts';
import type { BenchmarkConfig } from './benchmark.config.ts';
import { calibrate } from './calibration/index.ts';
import { createFixtureManager } from './fixtures/manager.ts';
import { publicExperimentConfiguration, readExperiment, readRunResult, verifiedSuccess, writeExperimentReport, writeRunReport } from './reports/index.ts';
import type { ExperimentDesign, ExperimentSummary } from './reports/index.ts';
import { prepareReportDirectory, readReportJson, writeReportFile } from './reports/files.ts';
import { runTask } from './runners/index.ts';
import { TraceRedactor } from './runners/telemetry.ts';
import { ArmSchema, ControlTransportSchema } from './schemas/types.ts';
import type { Arm, RunResult } from './schemas/types.ts';
import { getTaskDefinition, listTaskDefinitions, RUNNABLE_TASK_IDS, SMOKE_TASK_IDS, TASK_IDS } from './tasks/index.ts';
import { collectSourceManifest } from './isolation/source.ts';
import { StudyManifestSchema, type StudyManifest } from './schemas/tools-study.ts';
import { collectStudyHarnessHash, proveTreatment, verifyStudySources } from './runners/tools-study-source.ts';
import { runToolsStudy } from './runners/tools-study.ts';
import { readStudyResults, writeStudyReport } from './reports/tools-study.ts';
import { createStudyReportFixture } from './reports/tools-study-fixture.ts';
import { readNativeAccountCatalog } from './isolation/native-account.ts';

const benchmarkRoot = resolve(repositoryRoot, 'benchmarks/dovspace');
const stringOptions = ['config', 'task', 'arm', 'tasks', 'arms', 'repeat', 'experiment', 'output-root', 'runtime-root', 'output', 'run-id', 'control-transport', 'model', 'provider', 'provider-api', 'omp-model', 'provider-endpoint', 'provider-binary', 'model-options', 'api-key-env', 'host-auth-boundary', 'omp-sdk-root', 'omp-bun', 'omp-auth-store', 'max-cost-usd', 'max-duration-minutes', 'max-model-calls', 'max-tool-calls', 'price-input-per-million', 'price-output-per-million', 'price-cache-read-per-million', 'price-cache-write-per-million', 'price-version', 'price-basis', 'max-output-tokens', 'agent-image', 'code-image', 'postgres-image', 'manifest', 'baseline-source', 'candidate-source', 'study-results'] as const;
type StringOption = (typeof stringOptions)[number];
export interface CliArguments {
  command: 'help' | 'list' | 'fixtures' | 'run' | 'smoke' | 'compare' | 'report' | 'calibrate' | 'native-account-catalog' | 'native-account-list' | 'tools-study-prepare' | 'tools-study-validate' | 'tools-study' | 'tools-study-report' | 'tools-study-fixture';
  options: Partial<Record<StringOption, string>> & { json?: boolean; help?: boolean; 'run-result'?: string[] };
  taskIds: string[];
  arms: Arm[];
  repetitions: number;
}

export const HELP = `Dovspace-Bench Lite v0.2 — isolated real-model benchmark

Commands (pnpm --dir benchmarks/dovspace <script> ...):
  bench:list [--json]                       List twelve definitions; nine executable cases
  bench:fixtures:reset [--repeat 3]          Seed, snapshot and destroy fresh real fixtures
  bench:run --task K02 --arm dovspace        Execute one admitted real-model task
  bench:smoke --arm dovspace --repeat 2      Execute all six smoke cases with isolated resets
  bench:compare --tasks smoke --arms raw,dovspace --repeat 2 --experiment ab-01
  bench:report --experiment ab-01            Regenerate an experiment without inference
  bench:report --run-result outputs/RUN/result.json [--run-result ...] --experiment imported
  bench:calibrate [--output outputs/calibration/NAME]  Explicit independent-grader calibration
  tools-study-prepare --manifest TEMPLATE.json --baseline-source DIR --candidate-source DIR --output outputs/STUDY/manifest.json
  tools-study-validate --manifest PATH      Rehash actual independent sources; no inference
  tools-study --manifest PATH --api-key-env NAME [--output outputs/studies/ID]
  tools-study-report --study-results outputs/studies/ID/study-results.json [--output ...]
  tools-study-fixture --output outputs/study-report-fixture  Synthetic report smoke, NOT model evidence
  Study template: fixed support arm/tasks/repetitions/primaryMetric, maxTotalCostUsd, complete
  nonsecret controls (including controlTransport: http|cli), versioned prices, observationPolicy
  and exact treatment paths/rationales. Study controls cannot be overridden at execution.
  Preparation freezes actual sources and common harness; empty/no-op/foreign treatment is rejected.
  Whole-design per-run maximum costs are reserved before admission; missing usage never frees them.
  Targeted safety artifact declarations are unverified, not clearance; independent replay/safety failures veto.
  native-account-catalog --omp-sdk-root DIR --omp-bun /PATH/bun [--output outputs/catalog.json]
      Offline exact18.15 catalog metadata only; never opens an account or fetches discovery.
  native-account-list --omp-sdk-root DIR --omp-bun /PATH/bun --omp-auth-store /PATH/agent.db
      SDK account row IDs/fingerprints only; no tokens, usage probes, refresh, or inference.

Real-model arguments:
  --model ID                               REQUIRED explicit model (or model in --config JSON)
  --max-cost-usd USD                        REQUIRED positive per-run cap
  --provider-endpoint https://HOST/v1        Explicit OpenAI-compatible API base (not /responses)
  --api-key-env ENVIRONMENT_VARIABLE        Read only this explicitly named credential variable
  --price-input-per-million USD --price-output-per-million USD --max-output-tokens N
  --model-options JSON                      Explicit fixed model options, e.g. {"reasoningEffort":"xhigh"}
  --provider codex|omp --provider-api openai-responses|openai-completions|openai-codex-responses
  --control-transport http|cli               Fixed operator lane (default http); no CLI HTTP fallback
  --omp-model JSON                          REQUIRED explicit native model metadata for OMP
  --price-cache-read-per-million USD --price-cache-write-per-million USD --price-version ID
  --host-auth-boundary JSON                 Explicit native account row/fingerprint + SDK/catalog digests
  --omp-sdk-root DIR --omp-bun /PATH/bun --omp-auth-store /PATH/agent.db
      Host-only SDK access, never mounted or exported; native account mode rejects --api-key-env.
  --price-basis api-billing|catalog-estimate  Native Codex uses catalog estimates, not subscription bills.
      Native Codex omits output caps: --max-output-tokens must reserve its full128000-token limit.
  --max-model-calls N --max-tool-calls N --max-duration-minutes N
  --config PATH                            Nonsecret JSON config; no dotenv or inherited provider home
  --agent-image IMAGE --code-image IMAGE --postgres-image IMAGE --provider-binary /container/path
  --runtime-root PATH --output-root PATH    Absolute/relative paths under benchmarks/dovspace

Task budgets are ceilings; CLI/config caps can only lower them. Missing endpoint/key/pricing is
recorded as an explicit failed admitted run, never calibration, fallback inference or success.
Docker, the benchmark Agent image and real provider access are prerequisites. No production
service/port is reused. See benchmarks/dovspace/README.md before allowing billable inference.
`;

function positiveNumber(value: string, name: string, integer = false): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) throw new Error(`${name} must be a positive ${integer ? 'integer' : 'finite number'}`);
  return parsed;
}
function nonnegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite nonnegative number`);
  return parsed;
}
function selection(value: string, name: string): string[] {
  const values = value.split(',').map((part) => part.trim());
  if (values.some((part) => !part) || new Set(values).size !== values.length) throw new Error(`${name} must contain distinct comma-separated values`);
  return values;
}
function outputPath(value: string, tree: 'outputs' | '.runtime' = 'outputs'): string {
  const path = isAbsolute(value) ? resolve(value) : resolve(benchmarkRoot, value);
  const child = relative(resolve(benchmarkRoot, tree), path);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Paths must be descendants of the reserved benchmarks/dovspace/${tree} tree`);
  return path;
}

export function parseCliArgs(argv: string[]): CliArguments {
  const optionDefinitions: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = Object.fromEntries(stringOptions.map((name) => [name, { type: 'string' as const }]));
  optionDefinitions.help = { type: 'boolean' };
  optionDefinitions.json = { type: 'boolean' };
  optionDefinitions['run-result'] = { type: 'string', multiple: true };
  const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: optionDefinitions });
  const options = parsed.values as CliArguments['options'];
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option' || token.name === 'run-result') continue;
    if (seen.has(token.name)) throw new Error(`Repeated option: --${token.name}`);
    seen.add(token.name);
  }
  const [commandValue, ...positionals] = parsed.positionals;
  const command = options.help || !commandValue || commandValue === 'help' ? 'help' : commandValue;
  if (!['help', 'list', 'fixtures', 'run', 'smoke', 'compare', 'report', 'calibrate', 'native-account-catalog', 'native-account-list', 'tools-study-prepare', 'tools-study-validate', 'tools-study', 'tools-study-report', 'tools-study-fixture'].includes(command)) throw new Error(`Unknown benchmark command: ${command}`);
  if (command === 'fixtures' && (positionals.length !== 1 || positionals[0] !== 'reset')) throw new Error('Expected fixtures reset');
  if (command === 'run') {
    if (positionals.length > 1 || (positionals.length && options.task)) throw new Error('Specify one task with --task or a positional task, not both');
    if (positionals[0]) options.task = positionals[0];
    if (!options.task) throw new Error('run requires --task');
  } else if (command !== 'fixtures' && positionals.length) throw new Error(`Unexpected positional argument for ${command}`);
  if (options.task && command !== 'run') throw new Error('--task is only valid with run; use --tasks with compare');
  if (options.tasks && command !== 'compare') throw new Error('--tasks is only valid with compare');
  if (options.arms && command !== 'compare') throw new Error('--arms is only valid with compare');
  if (options.arm && command !== 'run' && command !== 'smoke') throw new Error('--arm is only valid with run or smoke');
  if (options['run-id'] && command !== 'run') throw new Error('--run-id is only valid with run');
  if (options['run-result'] && command !== 'report' && command !== 'tools-study-report') throw new Error('--run-result is only valid with report or tools-study-report');
  if (options.repeat && !['fixtures', 'smoke', 'compare'].includes(command)) throw new Error('--repeat is only valid with fixtures reset, smoke or compare');
  const taskIds = command === 'run' ? [getTaskDefinition(options.task!).id] : command === 'smoke' ? [...SMOKE_TASK_IDS] : command === 'compare'
    ? options.tasks === 'all' ? [...TASK_IDS] : !options.tasks || options.tasks === 'smoke' ? [...SMOKE_TASK_IDS] : selection(options.tasks, '--tasks').map((id) => getTaskDefinition(id).id)
    : [];
  for (const taskId of taskIds) {
    if (!RUNNABLE_TASK_IDS.some((id) => id === taskId)) throw new Error(`${taskId} is a complete definition only; executable tasks are ${RUNNABLE_TASK_IDS.join(' ')}. No substitute task is run.`);
  }
  const arms = command === 'compare' ? selection(options.arms ?? 'raw,dovspace', '--arms').map((arm) => ArmSchema.parse(arm)) : command === 'run' || command === 'smoke' ? [ArmSchema.parse(options.arm ?? 'dovspace')] : [];
  if (command === 'compare' && arms.length < 2) throw new Error('compare requires at least two distinct arms');
  if (options['control-transport'] !== undefined) ControlTransportSchema.parse(options['control-transport']);
  const repetitions = options.repeat ? positiveNumber(options.repeat, '--repeat', true) : 1;
  for (const name of ['max-cost-usd', 'max-duration-minutes'] as const) if (options[name] !== undefined) positiveNumber(options[name], `--${name}`);
  for (const name of ['max-model-calls', 'max-tool-calls', 'max-output-tokens'] as const) if (options[name] !== undefined) positiveNumber(options[name], `--${name}`, true);
  for (const name of ['price-input-per-million', 'price-output-per-million', 'price-cache-read-per-million', 'price-cache-write-per-million'] as const) if (options[name] !== undefined) nonnegativeNumber(options[name], `--${name}`);
  if (options.experiment !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(options.experiment)) throw new Error('--experiment must be a simple nonempty identifier');
  if (options['run-id'] !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(options['run-id'])) throw new Error('--run-id must contain only letters, numbers, underscores or hyphens (1–100 characters)');
  if (options['api-key-env'] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options['api-key-env'])) throw new Error('--api-key-env must name one environment variable, not its value');
  return { command: command as CliArguments['command'], options, taskIds, arms, repetitions };
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} must contain valid JSON (input withheld)`); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
function hostAccessForOptions(options: CliArguments['options'], requireStore = true): { sdkRoot: string; bunBinary: string; authStorePath?: string } | undefined {
  if (!options['omp-sdk-root'] && !options['omp-bun'] && !options['omp-auth-store']) return undefined;
  const sdkRoot = options['omp-sdk-root'], bunBinary = options['omp-bun'], authStorePath = options['omp-auth-store'];
  if (!sdkRoot || !bunBinary || requireStore && !authStorePath || [sdkRoot, bunBinary, authStorePath].some(value => value !== undefined && !isAbsolute(value))) throw new Error('Explicit absolute --omp-sdk-root, --omp-bun and --omp-auth-store are required for trusted-host SDK access');
  return { sdkRoot, bunBinary, ...(authStorePath ? { authStorePath } : {}) };
}

async function nativeAccountMetadata(args: CliArguments): Promise<number> {
  const accounts = args.command === 'native-account-list';
  const admitted = accounts ? ['omp-sdk-root', 'omp-bun', 'omp-auth-store', 'output', 'json'] : ['omp-sdk-root', 'omp-bun', 'output', 'json'];
  for (const name of Object.keys(args.options)) if (!admitted.includes(name)) throw new Error(`--${name} is not supported by ${args.command}`);
  const access = hostAccessForOptions(args.options, accounts);
  if (!access) throw new Error('Explicit --omp-sdk-root and --omp-bun are required; account listing also requires --omp-auth-store');
  const metadata = await readNativeAccountCatalog(access, accounts);
  if (args.options.output) {
    const target = outputPath(args.options.output);
    await prepareReportDirectory(resolve(target, '..'));
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(metadata, null, 2) + '\n'); } finally { await file.close(); }
    console.log(JSON.stringify({ output: target, inferencePerformed: false, accountRefreshPerformed: false }));
  } else console.log(JSON.stringify(metadata, null, 2));
  return 0;
}


export async function configForCommand(args: CliArguments, environment: NodeJS.ProcessEnv = process.env): Promise<BenchmarkConfig> {
  const options = args.options;
  let input: Record<string, unknown> = {};
  if (options.config) {
    if (!options.config.toLowerCase().endsWith('.json')) throw new Error('Config must be an explicitly named nonsecret .json file; dotenv files are never loaded');
    const value = await readReportJson(resolve(options.config));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Config must be a JSON object');
    input = value as Record<string, unknown>;
    if ('providerApiKey' in input) throw new Error('Do not store providerApiKey in config; explicitly select --api-key-env instead');
    if ('hostAuthAccess' in input) throw new Error('Host SDK access paths are CLI-only; never persist hostAuthAccess in configuration or study artifacts');
  }
  for (const [name, key] of [['control-transport', 'controlTransport'], ['model', 'model'], ['provider', 'provider'], ['provider-api', 'providerApi'], ['provider-endpoint', 'providerEndpoint'], ['provider-binary', 'providerBinary'], ['agent-image', 'agentImage'], ['code-image', 'codeImage'], ['postgres-image', 'postgresImage']] as const) {
    if (options[name] !== undefined) input[key] = options[name];
  }
  if (options['output-root']) input.outputsRoot = outputPath(options['output-root']);
  if (options['runtime-root']) input.runtimeRoot = outputPath(options['runtime-root'], '.runtime');
  if (options['model-options']) {
    input.modelOptions = parseObject(options['model-options'], '--model-options');
  }
  if (options['omp-model']) input.ompModel = parseObject(options['omp-model'], '--omp-model');
  if (options['host-auth-boundary']) input.hostAuthBoundary = parseObject(options['host-auth-boundary'], '--host-auth-boundary');
  const hostAccess = hostAccessForOptions(options);
  if (hostAccess) input.hostAuthAccess = hostAccess;
  if (input.hostAuthBoundary && options['api-key-env']) throw new Error('Explicit native account auth cannot be combined with an API-key selection');
  const allTasks = listTaskDefinitions();
  const defaultBudget = { maxDurationMinutes: Math.max(...allTasks.map((task) => task.budget.maxDurationMinutes)), maxModelCalls: Math.max(...allTasks.map((task) => task.budget.maxModelCalls)), maxToolCalls: Math.max(...allTasks.map((task) => task.budget.maxToolCalls)), maxCostUsd: null };
  if (input.budget !== undefined && (typeof input.budget !== 'object' || input.budget === null || Array.isArray(input.budget))) throw new Error('Config budget must be an object');
  const budget: Record<string, unknown> = { ...defaultBudget, ...(input.budget as Record<string, unknown> | undefined) };
  for (const [name, key, integer] of [['max-cost-usd', 'maxCostUsd', false], ['max-duration-minutes', 'maxDurationMinutes', false], ['max-model-calls', 'maxModelCalls', true], ['max-tool-calls', 'maxToolCalls', true]] as const) {
    if (options[name] !== undefined) budget[key] = positiveNumber(options[name], `--${name}`, integer);
  }
  input.budget = budget;
  if (['run', 'smoke', 'compare'].includes(args.command)) {
    if (typeof input.model !== 'string' || !input.model.trim()) throw new Error('Real-model execution requires an explicit --model or model in config; no model is auto-selected');
    if (typeof budget.maxCostUsd !== 'number' || !Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0) throw new Error('Real-model execution requires an explicit positive --max-cost-usd or budget.maxCostUsd');
  }
  if (input.prices !== undefined && (typeof input.prices !== 'object' || input.prices === null || Array.isArray(input.prices))) throw new Error('Config prices must be an object');
  const prices: Record<string, unknown> = { ...(input.prices as Record<string, unknown> | undefined) };
  for (const [name, key] of [['price-input-per-million', 'inputPerMillion'], ['price-output-per-million', 'outputPerMillion'], ['price-cache-read-per-million', 'cacheReadPerMillion'], ['price-cache-write-per-million', 'cacheWritePerMillion']] as const) if (options[name] !== undefined) prices[key] = nonnegativeNumber(options[name], `--${name}`);
  if (options['max-output-tokens']) prices.maxOutputTokens = positiveNumber(options['max-output-tokens'], '--max-output-tokens', true);
  if (options['price-version']) prices.version = options['price-version'];
  if (options['price-basis']) prices.basis = options['price-basis'];
  if (Object.keys(prices).length) input.prices = prices;
  if (options['api-key-env']) {
    const key = environment[options['api-key-env']];
    if (key) input.providerApiKey = key;
  }
  return parseBenchmarkConfig(input);
}

async function resetFixtures(args: CliArguments): Promise<number> {
  const config = await configForCommand(args);
  const manager = createFixtureManager(config);
  const directory = outputPath(args.options.output ?? `outputs/reset-${randomUUID()}`);
  await prepareReportDirectory(directory, true);
  const snapshots: Array<{ fixtureId: string; fixtureVersion: string; semanticHash: string; entities: number; receipts: number }> = [];
  let failure: string | null = null;
  let resourcesDestroyed = true;
  try {
    for (let index = 0; index < args.repetitions; index += 1) {
      resourcesDestroyed = false;
      const fixture = await manager.reset({ runId: `reset-${randomUUID()}` });
      try {
        const snapshot = await manager.snapshot(fixture);
        snapshots.push({ fixtureId: snapshot.fixtureId, fixtureVersion: snapshot.fixtureVersion, semanticHash: snapshot.semanticHash, entities: snapshot.entities.length, receipts: snapshot.receipts.length });
      } finally {
        await manager.destroy(fixture);
        resourcesDestroyed = true;
      }
    }
  } catch (error) {
    failure = new TraceRedactor().text(error instanceof Error ? error.message : String(error));
  }
  const reproducible = snapshots.length === args.repetitions && new Set(snapshots.map((snapshot) => snapshot.semanticHash)).size === 1 && new Set(snapshots.map((snapshot) => snapshot.fixtureId)).size === snapshots.length;
  const result = { kind: 'fixture-reset', success: failure === null && reproducible && resourcesDestroyed, expectedResets: args.repetitions, snapshots, failure, resourcesDestroyed };
  await writeReportFile(resolve(directory, 'reset.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeReportFile(resolve(directory, 'reset.md'), `# Isolated fixture reset\n\nSuccess: **${result.success ? 'yes' : 'no'}**\n\nEach reset provisions and destroys its own real authority. This is fixture infrastructure evidence, not a model benchmark.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify({ success: result.success, report: resolve(directory, 'reset.json'), failure }));
  return result.success ? 0 : 1;
}

async function runModels(args: CliArguments): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Benchmark interrupted by operator'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try { return await executeModels(args, controller.signal); }
  finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

async function executeModels(args: CliArguments, signal: AbortSignal): Promise<number> {
  const config = await configForCommand(args);
  await prepareReportDirectory(config.outputsRoot);
  if (args.command === 'run') {
    const options = { taskId: args.taskIds[0]!, arm: args.arms[0]!, config, signal, ...(args.options['run-id'] ? { runId: args.options['run-id'] } : {}) };
    const result = await runTask(options);
    console.log(JSON.stringify({ runId: result.runId, success: verifiedSuccess(result), failure: result.failure?.category ?? null, report: resolve(config.outputsRoot, result.runId, 'report.md') }));
    return verifiedSuccess(result) ? 0 : 1;
  }
  const experimentId = args.options.experiment ?? `${args.command}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = outputPath(args.options.output ?? `outputs/experiments/${experimentId}`);
  await prepareReportDirectory(directory, true);
  const design: ExperimentDesign = { taskIds: args.taskIds, arms: args.arms, repetitions: args.repetitions };
  const runs: RunResult[] = [];
  const resultPaths: Record<string, string> = {};
  const createdAt = new Date().toISOString();
  let summary: ExperimentSummary;
  try {
    suite: for (let repeat = 0; repeat < args.repetitions; repeat += 1) {
      for (let taskIndex = 0; taskIndex < args.taskIds.length; taskIndex += 1) {
        // Rotate serial arm order; state is never shared even within a matched block.
        const offset = (repeat + taskIndex) % args.arms.length;
        for (let armIndex = 0; armIndex < args.arms.length; armIndex += 1) {
          if (signal.aborted) break suite;
          const arm = args.arms[(offset + armIndex) % args.arms.length]!;
          const result = await runTask({ taskId: args.taskIds[taskIndex]!, arm, config, signal });
          runs.push(result);
          resultPaths[result.runId] = resolve(config.outputsRoot, result.runId, 'result.json');
          if (signal.aborted || result.failure?.category === 'interrupted') break suite;
        }
      }
    }
  } finally {
    summary = await writeExperimentReport(runs, directory, { experimentId, design, createdAt, resultPaths, configuration: publicExperimentConfiguration(config) });
  }
  console.log(JSON.stringify({ experimentId, fair: summary.fairness.valid, attempts: summary.overall.attempts, successes: summary.overall.successes, report: resolve(directory, 'comparison.md') }));
  return summary.fairness.valid && summary.overall.successes === summary.overall.attempts ? 0 : 1;
}

async function regenerateReport(args: CliArguments): Promise<number> {
  const paths = args.options['run-result']?.map((path) => outputPath(path));
  if (paths?.length) {
    const runs = await Promise.all(paths.map((path) => readRunResult(resolve(path))));
    if (runs.length === 1 && !args.options.experiment) {
      await writeRunReport(runs[0]!, resolve(paths[0]!, '..'));
      console.log(JSON.stringify({ report: resolve(paths[0]!, '..', 'report.md') }));
      return 0;
    }
    const experimentId = args.options.experiment ?? `imported-${randomUUID()}`;
    const directory = outputPath(args.options.output ?? `outputs/experiments/${experimentId}`);
    const resultPaths = Object.fromEntries(runs.map((run, index) => [run.runId, resolve(paths[index]!)]));
    const summary = await writeExperimentReport(runs, directory, { experimentId, resultPaths });
    console.log(JSON.stringify({ fair: summary.fairness.valid, report: resolve(directory, 'comparison.md') }));
    return summary.fairness.valid ? 0 : 1;
  }
  if (!args.options.experiment) throw new Error('report requires --experiment ID or one or more --run-result PATH');
  const directory = outputPath(`outputs/experiments/${args.options.experiment}`);
  const { runs, options } = await readExperiment(directory);
  const target = args.options.output ? outputPath(args.options.output) : directory;
  const summary = await writeExperimentReport(runs, target, options);
  console.log(JSON.stringify({ fair: summary.fairness.valid, report: resolve(target, 'comparison.md') }));
  return summary.fairness.valid ? 0 : 1;
}

async function toolsStudyCommand(args: CliArguments): Promise<number> {
  const options = args.options;
  const admittedOptions: Record<string, string[]> = {
    'tools-study-prepare': ['manifest', 'baseline-source', 'candidate-source', 'output', 'json'],
    'tools-study-validate': ['manifest', 'json'],
    'tools-study': ['manifest', 'api-key-env', 'omp-sdk-root', 'omp-bun', 'omp-auth-store', 'runtime-root', 'output', 'json'],
    'tools-study-report': ['manifest', 'study-results', 'run-result', 'output', 'json'],
    'tools-study-fixture': ['output', 'json'],
  };
  for (const name of Object.keys(options)) if (!admittedOptions[args.command]!.includes(name)) throw new Error(`--${name} cannot override preregistered controls or is not supported by ${args.command}`);
  if (args.command === 'tools-study-fixture') {
    const directory = outputPath(options.output ?? `outputs/study-report-fixture-${randomUUID()}`);
    await prepareReportDirectory(directory, true);
    const fixture = createStudyReportFixture();
    await writeStudyReport(fixture.runs, fixture.manifest, directory);
    console.log(JSON.stringify({ evidenceKind: 'report-fixture', inferencePerformed: false, report: resolve(directory, 'study-comparison.md'), results: resolve(directory, 'study-results.json') }));
    return 0;
  }
  if (args.command === 'tools-study-report') {
    let manifest: StudyManifest, runs: RunResult[];
    if (options['study-results']) {
      if (options.manifest || options['run-result']) throw new Error('Use --study-results alone, or --manifest with --run-result');
      ({ manifest, runs } = await readStudyResults(outputPath(options['study-results'])));
    } else {
      if (!options.manifest || !options['run-result']?.length) throw new Error('Study report requires --study-results or --manifest plus all --run-result inputs');
      manifest = StudyManifestSchema.parse(await readReportJson(resolve(options.manifest)));
      runs = await Promise.all(options['run-result'].map(file => readRunResult(outputPath(file))));
    }
    const directory = outputPath(options.output ?? `outputs/studies/${manifest.studyId}-report-${randomUUID()}`);
    const summary = await writeStudyReport(runs, manifest, directory);
    console.log(JSON.stringify({ evidenceKind: summary.evidenceKind, fair: summary.fairness.valid, safetyVeto: summary.safetyVeto, targetedSafetyEvidence: summary.targetedSafetyEvidence.status, conclusion: summary.conclusion, report: resolve(directory, 'study-comparison.md') }));
    return summary.fairness.valid && !summary.safetyVeto ? 0 : 1;
  }
  if (!options.manifest) throw new Error(`${args.command} requires --manifest`);
  const input = await readReportJson(resolve(options.manifest));
  if (args.command === 'tools-study-prepare') {
    if (!options['baseline-source'] || !options['candidate-source'] || !options.output) throw new Error('Preparation requires explicit independent --baseline-source, --candidate-source and --output manifest path');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Preregistration template must be an object');
    const template = input as Record<string, unknown>;
    if (!Array.isArray(template.treatment) || !template.treatment.every(item => item && typeof item === 'object' && typeof item.path === 'string' && typeof item.rationale === 'string')) throw new Error('Template treatment must list exact approved paths and rationales');
    const baseline = await collectSourceManifest(resolve(options['baseline-source'])), candidate = await collectSourceManifest(resolve(options['candidate-source']));
    const before = new Map(baseline.files.map(file => [file.path, file.sha256])), after = new Map(candidate.files.map(file => [file.path, file.sha256]));
    const treatment = (template.treatment as Array<{ path: string; rationale: string }>).map(item => ({ path: item.path, rationale: item.rationale, baseline: before.get(item.path) ?? null, candidate: after.get(item.path) ?? null }));
    const manifest = StudyManifestSchema.parse({ ...template, preregisteredAt: template.preregisteredAt ?? new Date().toISOString(), harnessHash: await collectStudyHarnessHash(), variants: { baseline: { sourceRoot: resolve(options['baseline-source']), sourceManifest: baseline }, candidate: { sourceRoot: resolve(options['candidate-source']), sourceManifest: candidate } }, treatment });
    await verifyStudySources(manifest);
    const target = outputPath(options.output);
    await prepareReportDirectory(resolve(target, '..'));
    // Exclusive manifest creation: a preregistration is never silently rewritten.
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); } finally { await file.close(); }
    console.log(JSON.stringify({ manifest: target, manifestHash: proveTreatment(manifest).manifestHash, inferencePerformed: false }));
    return 0;
  }
  const proof = await verifyStudySources(input);
  if (args.command === 'tools-study-validate') {
    console.log(JSON.stringify({ valid: true, studyId: proof.manifest.studyId, manifestHash: proof.manifestHash, differences: proof.differences, inferencePerformed: false }));
    return 0;
  }
  if (proof.manifest.controls.hostAuthBoundary && options['api-key-env']) throw new Error('Explicit native account study cannot select API-key fallback');
  const hostAccess = hostAccessForOptions(options);
  const config = parseBenchmarkConfig({
    ...proof.manifest.controls,
    ...(options['runtime-root'] ? { runtimeRoot: outputPath(options['runtime-root'], '.runtime') } : {}),
    ...(options['api-key-env'] && process.env[options['api-key-env']] ? { providerApiKey: process.env[options['api-key-env']] } : {}),
    ...(hostAccess ? { hostAuthAccess: hostAccess } : {}),
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Study interrupted by operator'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const directory = outputPath(options.output ?? `outputs/studies/${proof.manifest.studyId}/execution`);
    const summary = await runToolsStudy({ manifest: proof.manifest, config, outputDirectory: directory, signal: controller.signal });
    console.log(JSON.stringify({ studyId: summary.studyId, fair: summary.fairness.valid, attempts: summary.runs.length, safetyVeto: summary.safetyVeto, targetedSafetyEvidence: summary.targetedSafetyEvidence.status, conclusion: summary.conclusion, report: resolve(directory, 'study-comparison.md') }));
    return summary.fairness.valid && !summary.safetyVeto && summary.runs.every(verifiedSuccess) ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let redactor = new TraceRedactor();
  try {
    const args = parseCliArgs(argv);
    if (args.options['api-key-env']) redactor = new TraceRedactor([process.env[args.options['api-key-env']] ?? '']);
    switch (args.command) {
      case 'help': console.log(HELP); return 0;
      case 'list': {
        const tasks = listTaskDefinitions();
        if (args.options.json) {
          const publicTasks = tasks.map((task) => ({
            ...Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'hiddenGrader')),
            availability: RUNNABLE_TASK_IDS.includes(task.id) ? 'runnable-v0.2' : 'definition-only',
          }));
          console.log(JSON.stringify({ tasks: publicTasks, smoke: SMOKE_TASK_IDS, runnable: RUNNABLE_TASK_IDS }, null, 2));
        } else console.log(tasks.map((task) => `${task.id}\t${RUNNABLE_TASK_IDS.includes(task.id) ? 'runnable-v0.2' : 'definition-only'}\t${task.title}`).join('\n'));
        return 0;
      }
      case 'fixtures': return await resetFixtures(args);
      case 'native-account-catalog': case 'native-account-list': return await nativeAccountMetadata(args);
      case 'run': case 'smoke': case 'compare': return await runModels(args);
      case 'report': return await regenerateReport(args);
      case 'tools-study-prepare': case 'tools-study-validate': case 'tools-study': case 'tools-study-report': case 'tools-study-fixture': return await toolsStudyCommand(args);
      case 'calibrate': {
        const config = await configForCommand(args);
        const outputDir = outputPath(args.options.output ?? `outputs/calibration/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
        const result = await calibrate({ outputDir, runCodeTests: true, config });
        console.log(JSON.stringify({ kind: 'grader-calibration', success: result.success, model: null, report: resolve(outputDir, 'calibration.md') }));
        return result.success ? 0 : 1;
      }
    }
  } catch (error) {
    console.error(redactor.text(error instanceof Error ? error.message : String(error)));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
