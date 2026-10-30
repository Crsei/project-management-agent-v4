import type { RemoteSettings } from "@agent-workspace/contracts/chat";

/** Keep only actual remote fields, and retain fields changed after a saved snapshot. */
export function pendingRemoteSettings(
  patch: Partial<RemoteSettings> | undefined,
  allowedKeys: ReadonlySet<string>,
  saved?: RemoteSettings,
): Partial<RemoteSettings> | undefined {
  if (!patch) return undefined;
  const entries = Object.entries(patch).filter(([key, value]) => allowedKeys.has(key) &&
    (saved === undefined || JSON.stringify(saved[key as keyof RemoteSettings]) !== JSON.stringify(value)));
  return entries.length ? Object.fromEntries(entries) as Partial<RemoteSettings> : undefined;
}
