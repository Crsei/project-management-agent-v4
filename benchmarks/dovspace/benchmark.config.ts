import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BudgetSchema } from './schemas/types.ts';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURE_VERSION = 'dovspace-lite-0.1.0';
export const BenchmarkConfigSchema = z.object({
  runtimeRoot: z.string().default(path.join(repositoryRoot, 'benchmarks/dovspace/.runtime')),
  outputsRoot: z.string().default(path.join(repositoryRoot, 'benchmarks/dovspace/outputs')),
  postgresImage: z.string().default('postgres:16-alpine'),
  agentImage: z.string().default('dovspace-bench-agent:local'),
  codeImage: z.string().default('node:24.21.0-bookworm-slim'),
  dockerSocket: z.literal('unix:///var/run/docker.sock').default('unix:///var/run/docker.sock'),
  model: z.string().default(''),
  provider: z.literal('codex').default('codex'),
  providerBinary: z.string().min(1).default('/usr/local/bin/codex'),
  providerEndpoint: z.url().optional(),
  providerApiKey: z.string().min(1).optional(),
  modelOptions: z.record(z.string(), z.unknown()).default({}),
  prices: z.object({ inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(), maxOutputTokens: z.number().int().positive() }).optional(),
  budget: BudgetSchema.default({ maxDurationMinutes: 10, maxModelCalls: 30, maxToolCalls: 80, maxCostUsd: null }),
  startupTimeoutMs: z.number().int().min(1000).default(120_000),
}).strict();
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

/** No dotenv, inherited provider credentials, database URLs or service URLs are read. */
export function parseBenchmarkConfig(input: unknown = {}): BenchmarkConfig {
  const config = BenchmarkConfigSchema.parse(input);
  const benchRoot = path.join(repositoryRoot, 'benchmarks/dovspace');
  for (const [root, requiredFolder] of [[config.runtimeRoot, '.runtime'], [config.outputsRoot, 'outputs']] as const) {
    if (!path.isAbsolute(root)) throw new Error('Benchmark roots must be explicit absolute paths');
    const relative = path.relative(path.join(benchRoot, requiredFolder), root);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Benchmark storage must stay within its reserved .runtime or outputs tree');
  }
  if (config.modelOptions.fastMode === true || config.modelOptions.serviceTier !== undefined && config.modelOptions.serviceTier !== 'default') throw new Error('Benchmark cost boundary supports only the standard service tier');
  if (!path.posix.isAbsolute(config.providerBinary)) throw new Error('Provider binary must be an absolute container path');
  if (config.providerEndpoint) {
    const url = new URL(config.providerEndpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Provider endpoint must be HTTPS without embedded credentials or query');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Host-local provider endpoints are forbidden');
  }
  return config;
}
export const benchmarkConfig = parseBenchmarkConfig();
export const loadBenchmarkConfig = parseBenchmarkConfig;
