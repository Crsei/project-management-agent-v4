import * as Context from "effect/Context";

/** Supplied by the embedding host; no source orchestrator extension is loaded. */
export class PiHostResources extends Context.Service<PiHostResources, {
  readonly pmToolsExtensionPath: string;
}>()("@t3tools/provider-pi/server/PiHostResources") {}
