import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BudgetSchema, ControlTransportSchema } from './schemas/types.ts';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const FIXTURE_VERSION = 'dovspace-lite-0.2.0';
export const HostAuthBoundarySchema = z.object({
  kind: z.literal('omp-native-account'),
  provider: z.literal('openai-codex'),
  accountRowId: z.number().int().positive(),
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sdkVersion: z.literal('18.15.0'),
  sdkLockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  httpProxy: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/).refine(value => URL.canParse(value), 'Explicit credential-free loopback HTTP proxy required').optional(),
}).strict();
export const BenchmarkConfigSchema = z.object({
  runtimeRoot: z.string().default(path.join(repositoryRoot, 'benchmarks/dovspace/.runtime')),
  outputsRoot: z.string().default(path.join(repositoryRoot, 'benchmarks/dovspace/outputs')),
  postgresImage: z.string().default('postgres:16-alpine'),
  agentImage: z.string().default('dovspace-bench-agent:local'),
  codeImage: z.string().default('node:24.21.0-bookworm-slim'),
  dockerSocket: z.literal('unix:///var/run/docker.sock').default('unix:///var/run/docker.sock'),
  controlTransport: ControlTransportSchema.default('http'),
  model: z.string().default(''),
  provider: z.enum(['codex', 'omp']).default('codex'),
  providerBinary: z.string().min(1).optional(),
  providerApi: z.enum(['openai-responses', 'openai-completions', 'openai-codex-responses']).default('openai-responses'),
  hostAuthBoundary: HostAuthBoundarySchema.optional(),
  hostAuthAccess: z.object({ sdkRoot: z.string().min(1), bunBinary: z.string().min(1), authStorePath: z.string().min(1) }).strict().optional(),
  ompModel: z.object({
    contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(), reasoning: z.boolean(),
    thinking: z.object({ efforts: z.array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).min(1), mode: z.literal('effort').optional(), defaultLevel: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict().optional(),
    omitMaxOutputTokens: z.boolean().optional(),
    compat: z.object({ supportsStore: z.boolean().optional(), supportsDeveloperRole: z.boolean().optional(), supportsReasoningEffort: z.boolean().optional(), supportsUsageInStreaming: z.boolean().optional(), maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional() }).strict().optional(),
  }).strict().optional(),
  providerEndpoint: z.url().optional(),
  providerApiKey: z.string().min(1).optional(),
  modelOptions: z.record(z.string(), z.unknown()).default({}),
  prices: z.object({ inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(), cacheReadPerMillion: z.number().nonnegative().optional(), cacheWritePerMillion: z.number().nonnegative().optional(), maxOutputTokens: z.number().int().positive(), version: z.string().min(1).optional(), basis: z.enum(['api-billing', 'catalog-estimate']).optional() }).strict().optional(),
  budget: BudgetSchema.default({ maxDurationMinutes: 10, maxModelCalls: 30, maxToolCalls: 80, maxCostUsd: null }),
  startupTimeoutMs: z.number().int().min(1000).default(120_000),
}).strict();
export type BenchmarkConfig = Omit<z.infer<typeof BenchmarkConfigSchema>, 'providerBinary'> & { providerBinary: string };

/** No dotenv, inherited provider credentials, database URLs or service URLs are read. */
export function parseBenchmarkConfig(input: unknown = {}): BenchmarkConfig {
  const parsed = BenchmarkConfigSchema.parse(input);
  const config: BenchmarkConfig = { ...parsed, providerBinary: parsed.providerBinary ?? `/usr/local/bin/${parsed.provider}` };
  const benchRoot = path.join(repositoryRoot, 'benchmarks/dovspace');
  for (const [root, requiredFolder] of [[config.runtimeRoot, '.runtime'], [config.outputsRoot, 'outputs']] as const) {
    if (!path.isAbsolute(root)) throw new Error('Benchmark roots must be explicit absolute paths');
    const relative = path.relative(path.join(benchRoot, requiredFolder), root);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Benchmark storage must stay within its reserved .runtime or outputs tree');
  }
  if (config.modelOptions.fastMode === true || config.modelOptions.serviceTier !== undefined && config.modelOptions.serviceTier !== 'default') throw new Error('Benchmark cost boundary supports only the standard service tier');
  if (config.provider === 'codex' && config.providerApi !== 'openai-responses') throw new Error('Codex requires the OpenAI Responses transport');
  if (config.provider === 'omp') {
    if (Object.keys(config.modelOptions).some(key => key !== 'thinking')) throw new Error('The native OMP host currently exposes only the thinking model option; transport options must not be guessed');
    if (config.modelOptions.thinking !== undefined && (typeof config.modelOptions.thinking !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.modelOptions.thinking))) throw new Error('Invalid native OMP thinking option');
    if (config.ompModel && (config.ompModel.maxTokens > config.ompModel.contextWindow || config.ompModel.thinking && !config.ompModel.reasoning)) throw new Error('Inconsistent explicit OMP model metadata');
  } else if (config.ompModel) throw new Error('OMP model metadata cannot configure a Codex runtime');
  if (config.hostAuthBoundary) {
    if (config.provider !== 'omp' || config.providerApi !== 'openai-codex-responses' || config.model !== 'gpt-6.1-sol' || config.modelOptions.thinking !== 'xhigh') throw new Error('Native account selection requires exact openai-codex/gpt-6.1-sol with xhigh and its native Responses API');
    if (config.providerApiKey || config.providerEndpoint !== 'https://chatgpt.com/backend-api') throw new Error('Native account transport accepts only the official Codex origin and no API-key fallback');
    if (!config.ompModel?.omitMaxOutputTokens || config.ompModel.contextWindow !== 500000 || config.ompModel.maxTokens !== 128000 || !config.ompModel.reasoning || !config.ompModel.thinking?.efforts.includes('xhigh')) throw new Error('Native account model metadata must preserve the exact versioned catalog limits and output-cap semantics');
    if (!config.prices?.version || config.prices.basis !== 'catalog-estimate' || config.prices.maxOutputTokens < config.ompModel.maxTokens) throw new Error('Codex omits output caps: reserve the full catalog output limit with versioned catalog-estimate prices, not subscription billing');
  } else if (config.providerApi === 'openai-codex-responses' || config.hostAuthAccess) throw new Error('Native account auth must be explicitly selected; it is never inferred from API/model/environment');
  if (config.hostAuthAccess && Object.values(config.hostAuthAccess).some(value => !path.isAbsolute(value))) throw new Error('Trusted host SDK, runtime and credential-store paths must be explicitly absolute');
  if (!path.posix.isAbsolute(config.providerBinary)) throw new Error('Provider binary must be an absolute container path');
  if (config.providerEndpoint) {
    const url = new URL(config.providerEndpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Provider endpoint must be HTTPS without embedded credentials or query');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Host-local provider endpoints are forbidden');
    if (/\/(?:responses|chat\/completions)\/?$/.test(url.pathname)) throw new Error('Provider endpoint must be the API base URL, not an operation endpoint');
  }
  return config;
}
export function ompModelSelector(config: Pick<BenchmarkConfig, 'model' | 'hostAuthBoundary'>): string {
  return `${config.hostAuthBoundary?.provider ?? 'bench'}/${config.model}`;
}
export const benchmarkConfig = parseBenchmarkConfig();
export const loadBenchmarkConfig = parseBenchmarkConfig;
