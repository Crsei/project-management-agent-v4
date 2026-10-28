import type { NativeProviderAdapter } from "./driver-adapter.ts";
import { codexAdapter } from "./drivers/codex.ts";
import { claudeAdapter } from "./drivers/claude.ts";
import { cursorAdapter } from "./drivers/cursor.ts";
import { grokAdapter } from "./drivers/grok.ts";
import { opencodeAdapter } from "./drivers/opencode.ts";
import { antigravityAdapter } from "./drivers/antigravity.ts";
import { museAdapter } from "./drivers/muse.ts";
import { piAdapter } from "./drivers/pi.ts";
import { acpRegistryAdapter } from "./drivers/acpRegistry.ts";

/** Same native Agent inventory/order as t3code's provider client registry. */
export const nativeProviderAdapters: readonly NativeProviderAdapter[] = [
  codexAdapter, claudeAdapter, cursorAdapter, grokAdapter, opencodeAdapter,
  antigravityAdapter, museAdapter, piAdapter, acpRegistryAdapter,
];
const adaptersByDriver = new Map(nativeProviderAdapters.map((adapter) => [adapter.definition.driver, adapter]));
export function getNativeProviderAdapter(driver: string): NativeProviderAdapter | null {
  return adaptersByDriver.get(driver as Parameters<typeof adaptersByDriver.get>[0]) ?? null;
}
