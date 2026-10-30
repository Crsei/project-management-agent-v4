import * as Context from "effect/Context";

/** Application-private native SDK resources; these never redirect the native Home. */
export class CursorHostPaths extends Context.Service<CursorHostPaths, {
  readonly legacyCredentialsFile: string;
}>()("@t3tools/provider-cursor/server/CursorHostPaths") {}
