import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderRuntimeHost, type ProviderRuntimeHostBinding } from "@t3tools/provider-core/server/ProviderRuntimeHost";
export { ProviderRuntimeHost };
export const layer = Layer.sync(ProviderRuntimeHost, () => {
  const bindings = new Map<string, { binding: ProviderRuntimeHostBinding; authorize?: (action: "compaction" | "tool") => Effect.Effect<void, Error> }>();
  const key = (input: { readonly threadId: string; readonly providerInstanceId: string }) => JSON.stringify([input.threadId, input.providerInstanceId]);
  return { read: input => Effect.sync(() => bindings.get(key(input))?.binding),
    bind: (input, authorize) => Effect.acquireRelease(Effect.sync(() => { bindings.set(key(input), { binding: input, ...(authorize ? { authorize } : {}) }); }),
      () => Effect.sync(() => { if (bindings.get(key(input))?.binding === input) bindings.delete(key(input)); })),
    authorize: input => Effect.suspend(() => {
      const entry = bindings.get(key(input));
      return entry?.binding.executionId === input.executionId && entry.authorize
        ? entry.authorize(input.action) : Effect.fail(new Error("The test generation did not grant this native action."));
    }),
  };
});
