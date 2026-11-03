import * as Effect from "effect/Effect";
import type { ProviderRuntimeHostBinding, ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/** One instance is shared by the driver layer and the execution service. */
export function makePmProviderRuntimeHost(): ProviderRuntimeHostService {
  type Authorization = NonNullable<Parameters<ProviderRuntimeHostService["bind"]>[1]>;
  const bindings = new Map<string, {
    binding: ProviderRuntimeHostBinding;
    authorization: Authorization | undefined;
    owners: Set<symbol>;
  }>();
  const key = (input: { providerInstanceId: string; threadId: string }) => JSON.stringify([input.providerInstanceId, input.threadId]);
  return {
    read: (input) => Effect.sync(() => bindings.get(key(input))?.binding),
    authorize: (input) => Effect.gen(function* () {
      const id = key(input);
      const current = yield* Effect.sync(() => bindings.get(id));
      const stale = Object.assign(new Error("Provider execution authorization is missing or no longer current."), {
        status: 409, code: "stale_execution",
      });
      const authorization = current?.authorization;
      if (!current || !authorization || current.binding.executionId !== input.executionId || !current.owners.size)
        return yield* Effect.fail(stale);
      if (input.action === "tool" && current.binding.promptAuthorization === "technical-no-tools")
        return yield* Effect.fail(Object.assign(new Error("Technical provider requests cannot authorize tools."), { status: 403, code: "scope_required" }));
      yield* Effect.suspend(() => authorization(input.action));
      if (bindings.get(id) !== current || !current.owners.size)
        return yield* Effect.fail(stale);
    }),
    bind: (binding, authorization) => Effect.acquireRelease(
      Effect.sync(() => {
        const id = key(binding);
        const token = Symbol();
        const current = bindings.get(id);
        if (current && (current.authorization !== authorization || JSON.stringify(current.binding) !== JSON.stringify(binding)))
          throw Object.assign(new Error("Conflicting live provider execution binding."), { status: 409, code: "provider_busy" });
        if (current) current.owners.add(token);
        else bindings.set(id, { binding, authorization, owners: new Set([token]) });
        return { id, token };
      }),
      ({ id, token }) => Effect.sync(() => {
        const current = bindings.get(id);
        if (!current?.owners.delete(token)) return;
        if (!current.owners.size) bindings.delete(id);
      }),
    ).pipe(Effect.asVoid),
  };
}

/** Only server-constructed Chat context may grant access to the existing PM transport. */
export function pmRuntimeBinding(context: ProviderDriverContext, threadId: ThreadId, executionId: string): ProviderRuntimeHostBinding {
  if (context.pmAnalysis && (context.pmToolBridge || context.mcpServers?.length))
    throw Object.assign(new Error("Technical analysis cannot inject native tools."), { status: 412, code: "scope_required" });
  const names = new Set<string>();
  for (const server of context.mcpServers ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(server.name) || names.has(server.name))
      throw Object.assign(new Error("MCP descriptors require unique valid server names."), { status: 412, code: "scope_required" });
    names.add(server.name);
  }
  if ((context.pmToolBridge || context.mcpServers?.length) && (!context.execution || !context.authorizeExecution))
    throw Object.assign(new Error("PM tools require a trusted live Chat authorization."), { status: 412, code: "scope_required" });
  const bridge = context.pmToolBridge;
  if (context.mcpServers?.some(server => server.name === "pm_tools"))
    throw Object.assign(new Error("Execution connectors cannot replace the PM tool transport."), { status: 412, code: "scope_required" });
  return {
    providerInstanceId: ProviderInstanceId.make(context.instanceId), threadId, executionId,
    ...(context.pmAnalysis || !context.execution && !bridge ? { promptAuthorization: "technical-no-tools" as const } : {}),
    cwd: context.cwd, nativePermissions: "deny-ungranted", instructionText: "",
    mcpServers: [...(bridge ? [{ name: "pm_tools", transport: "stdio" as const, command: bridge.command, args: [...bridge.args, "mcp"] }] : []), ...context.mcpServers ?? []],
  };
}
