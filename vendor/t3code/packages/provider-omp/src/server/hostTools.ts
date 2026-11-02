import type { ProviderRuntimeHostBinding, ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as Effect from "effect/Effect";
import type { OmpRpcRecord } from "./rpc.ts";

export interface OmpHostToolDefinition extends OmpRpcRecord {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}
export interface OmpHostTools {
  readonly binding: ProviderRuntimeHostBinding;
  readonly tools: ReadonlyArray<OmpHostToolDefinition>;
  readonly names: ReadonlySet<string>;
  readonly authorize: Effect.Effect<void, Error>;
  readonly call: (request: OmpRpcRecord) => Effect.Effect<OmpRpcRecord, Error>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function transportError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("OMP PM tool transport failed");
}

/** The explicit host marker grants model/questions only. Empty tools alone
 * never imply technical authority, and a failed Chat authorization never falls
 * back to this path. Native/PM tool calls keep the strict authorize effect. */
export const authorizeOmpPrompt = Effect.fn("authorizeOmpPrompt")(function* (
  binding: ProviderRuntimeHostBinding,
  runtimeHost: ProviderRuntimeHostService,
) {
  if (binding.promptAuthorization !== "technical-no-tools")
    return yield* runtimeHost.authorize({ threadId: binding.threadId, providerInstanceId: binding.providerInstanceId,
      executionId: binding.executionId, action: "tool" });
  if (binding.mcpServers.length || binding.nativePermissions !== "deny-ungranted")
    return yield* Effect.fail(new Error("OMP technical prompt authority cannot grant native or PM tools"));
  const current = yield* runtimeHost.read({ threadId: binding.threadId, providerInstanceId: binding.providerInstanceId });
  if (!current || current.promptAuthorization !== "technical-no-tools" || current.executionId !== binding.executionId ||
    current.threadId !== binding.threadId || current.providerInstanceId !== binding.providerInstanceId || current.cwd !== binding.cwd ||
    current.nativePermissions !== "deny-ungranted" || current.mcpServers.length || current.instructionText !== binding.instructionText)
    return yield* Effect.fail(new Error("OMP technical prompt binding is missing or no longer current"));
});

/** Reuse the generation-owned PM bridge. No credentials cross stdio/argv/env.
 * The bridge remains the authority for schema validation, destructive-action
 * approvals, operation IDs, revisions and receipts; this module only transports.
 */
export const makeOmpHostTools = Effect.fn("makeOmpHostTools")(function* (
  binding: ProviderRuntimeHostBinding,
  runtimeHost: ProviderRuntimeHostService,
) {
  if (binding.nativePermissions !== "deny-ungranted") return yield* Effect.fail(new Error("OMP requires deny-ungranted native permissions"));
  const authorize = binding.promptAuthorization === "technical-no-tools"
    ? Effect.fail(new Error("OMP technical prompt authority grants no native or PM tools"))
    : runtimeHost.authorize({ threadId: binding.threadId,
      providerInstanceId: binding.providerInstanceId, executionId: binding.executionId, action: "tool" });
  const servers = binding.mcpServers;
  if (servers.length > 1 || (servers.length === 1 && servers[0]?.name !== "pm_tools"))
    return yield* Effect.fail(new Error("OMP supports only the host's generation-owned PM tools bridge"));
  const server = servers[0];
  const endpoints = server?.args.filter(arg => /^http:\/\/127\.0\.0\.1:\d+$/.test(arg)) ?? [];
  if (server && (server.transport !== "stdio" || endpoints.length !== 1 || server.args.at(-1) !== "mcp"))
    return yield* Effect.fail(new Error("OMP PM tools require the generation-owned loopback endpoint"));
  yield* authorizeOmpPrompt(binding, runtimeHost);
  const endpoint = endpoints[0];
  const tools: OmpHostToolDefinition[] = [];
  if (endpoint) {
    const listing = yield* Effect.tryPromise({ try: async signal => {
      const response = await fetch(`${endpoint}/tools/list`, { signal, redirect: "error" });
      if (!response.ok) throw new Error("OMP PM tool discovery failed");
      return await response.json() as unknown;
    }, catch: transportError });
    if (!object(listing) || !Array.isArray(listing.tools)) return yield* Effect.fail(new Error("Invalid PM tool registry"));
    const seen = new Set<string>();
    for (const tool of listing.tools) {
      if (!object(tool) || typeof tool.name !== "string" || !/^pm_[a-z_]+$/.test(tool.name) || seen.has(tool.name) ||
        typeof tool.description !== "string" || !object(tool.inputSchema))
        return yield* Effect.fail(new Error("Invalid PM tool schema or duplicate name"));
      seen.add(tool.name);
      // Native set_host_tools accepts JSON Schema directly. Do not translate or
      // simplify schemas (notably required/additionalProperties/union fields).
      tools.push({ name: tool.name, label: tool.name, description: tool.description,
        parameters: tool.inputSchema, loadMode: "essential" });
    }
  }
  yield* authorizeOmpPrompt(binding, runtimeHost);
  const names = new Set(tools.map(tool => tool.name));
  return { binding, tools, names, authorize,
    call: (request: OmpRpcRecord) => Effect.gen(function* () {
      if (!endpoint || typeof request.id !== "string" || typeof request.toolCallId !== "string" ||
        typeof request.toolName !== "string" || !names.has(request.toolName) || !object(request.arguments))
        return yield* Effect.fail(new Error("OMP host tool request was not admitted"));
      // Use the binding captured at generation admission, never a later read().
      yield* authorize;
      const result = yield* Effect.tryPromise({ try: async signal => {
        const response = await fetch(`${endpoint}/tools/mcp-call`, { method: "POST", signal, redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transportId: `omp-native:${binding.executionId}`, requestId: request.id,
            name: request.toolName, arguments: request.arguments }) });
        const value: unknown = await response.json();
        if (!response.ok) throw new Error("OMP PM tool transport rejected the request");
        return value;
      }, catch: transportError });
      yield* authorize;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }),
  } satisfies OmpHostTools;
});
