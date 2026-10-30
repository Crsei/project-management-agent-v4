import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { providerDataDirectory } from "../instances.ts";
import { acpRegistryInstallationMethods, makeAcpRegistryCatalogLayer } from "../t3code/families/acp-registry.ts";

/** Preserve the current HTTP DTO; ranking, compatibility and preparation are source-owned. */
export async function searchAcpRegistry(input: {
  query?: string; limit?: number; signal?: AbortSignal; excludedAgentIds?: readonly string[];
  env?: NodeJS.ProcessEnv; cwd?: string;
} = {}) {
  const root = providerDataDirectory();
  const env = input.env ?? process.env;
  const context: ProviderDriverContext = {
    instanceId: "acp-registry-catalog", driver: "acpRegistry", revision: 0, config: {},
    cwd: input.cwd ?? process.cwd(), homeDirectory: env.HOME || env.USERPROFILE || os.homedir(),
    stateDirectory: path.join(root, "provider-cache", "acp-registry"), env,
  };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const catalog = yield* AcpRegistryCatalog;
    return yield* catalog.search({ query: input.query ?? "", limit: 512 });
  })).pipe(Effect.provide(makeAcpRegistryCatalogLayer(context))), { signal: input.signal });
  const excluded = new Set(input.excludedAgentIds ?? []);
  const agents = result.agents.filter(agent => !excluded.has(agent.id)).map(({ distribution, ...agent }) => ({
    ...agent, distributions: [distribution],
  }));
  return { total: agents.length, agents: agents.slice(0, input.limit ?? 20) };
}

/** Existing routes own mutation exclusion; the source catalog owns process/file locks. */
export const prepareAcpRegistry = acpRegistryInstallationMethods.prepare!;

