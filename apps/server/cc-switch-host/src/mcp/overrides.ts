/** Translated from vendor/cc-switch/src-tauri/src/mcp/overrides.rs. */

function merge(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = target === null || typeof target !== "object" || Array.isArray(target)
    ? {}
    : { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = merge(base[key], value);
  }
  return base;
}

/**
 * Explicit agent patches may change native options; absent options keep the
 * adapter's native-owned merge policy. Connection fields are already replaced
 * with the effective spec by each adapter before this helper runs.
 */
export function applyOptions(
  native: Record<string, unknown>,
  patch: unknown,
  connectionFields: readonly string[],
): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (connectionFields.includes(key) || key === "enabled" || key === "disabled"
      || key === "serverName" || key === "serverUrl" || key === "transport") continue;
    if (value === null) delete native[key];
    else native[key] = merge(native[key], value);
  }
}
