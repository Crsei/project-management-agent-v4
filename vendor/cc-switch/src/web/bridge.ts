import type { AppId } from "../lib/api/types";
import type { ExtensionContext, ExtensionDirectory, ExtensionEvent } from "@agent-workspace/contracts/extensions";

export type ManagementContext = ExtensionContext;
export type ManagementEvent = { event: ExtensionEvent["event"] | "heartbeat" | "reconnected"; data: unknown };
export interface DirectoryRequest { kind: "skills" | "skill"; directory?: string; subdirectory?: string }
export type DirectoryListing = ExtensionDirectory;
export interface WebPlatform {
  context: ManagementContext;
  contexts?: readonly ManagementContext[];
  selectContext?(contextId: string): Promise<boolean>;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  upload(file: File): Promise<string>;
  subscribe(listener: (event: ManagementEvent) => void): () => void;
  openDirectory(request: DirectoryRequest): Promise<void>;
  portal: HTMLElement;
  content: HTMLElement;
}

// The application mounts one management surface at a time. An explicit lease,
// not Tauri globals, binds the copied imperative APIs to that authorized surface.
let active: WebPlatform | undefined;
export function mountWebPlatform(platform: WebPlatform): () => void {
  if (active && active !== platform) throw new Error("Another extension management surface is already mounted.");
  active = platform;
  return () => { if (active === platform) active = undefined; };
}
export function webPlatform(): WebPlatform {
  if (!active) throw new Error("Extension management is not mounted.");
  return active;
}
export function isTargetAvailable(app: string): boolean { return webPlatform().context.apps.some(id => id === app); }
export function getPortalContainer(): HTMLElement { return webPlatform().portal; }
export function getContentContainer(): HTMLElement { return webPlatform().content; }
export function contextStorageKey(key: string): string { return `cc-switch:${webPlatform().context.id}:${key}`; }

export class Channel<T> {
  onmessage?: (message: T) => void;
}
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (command === "cancel_mcp_connectivity_checks") {
    const batch = channelSubscriptions.get(String(args.batchId));
    if (batch) {
      batch.unsubscribe(); channelSubscriptions.delete(String(args.batchId));
      await batch.cancel();
      return undefined as T;
    }
  }
  const platform = webPlatform();
  const app = args.app ?? args.currentApp;
  if (typeof app === "string" && !platform.context.apps.some(id => id === app)) {
    throw new Error(`No authorized ${app} target is registered in this context.`);
  }
  if (command === "upsert_mcp_server") {
    const server = args.server as { apps?: Record<string, boolean> } | undefined;
    for (const [id, enabled] of Object.entries(server?.apps ?? {})) {
      if (enabled && !platform.context.apps.some(app => app === id)) throw new Error(`No authorized ${id} target is registered in this context.`);
    }
  }
  const channel = args.onResult;
  if (channel instanceof Channel) {
    const remaining = new Set(args.serverIds as string[]);
    let batchId: string | undefined;
    const early: Array<{ batchId: string; serverId: string; connected: boolean }> = [];
    const deliver = (result: { batchId: string; serverId: string; connected: boolean }) => {
      if (result.batchId !== batchId || !remaining.delete(result.serverId)) return;
      channel.onmessage?.(result);
      if (!remaining.size) { unsubscribe(); channelSubscriptions.delete(result.batchId); }
    };
    const unsubscribe = platform.subscribe(({ event, data }) => {
      if (event !== "mcp-connectivity" || !data || typeof data !== "object") return;
      const result = data as { batchId: string; serverId: string; connected: boolean };
      if (batchId === undefined) early.push(result); else deliver(result);
    });
    const { onResult: _channel, ...wireArgs } = args;
    try {
      const result = await platform.invoke<T>(command, wireArgs);
      batchId = String(result);
      if (active !== platform) {
        unsubscribe(); await platform.invoke("cancel_mcp_connectivity_checks", { batchId });
        throw new Error("Management context changed during connectivity registration.");
      }
      channelSubscriptions.set(batchId, { unsubscribe, cancel: () => platform.invoke<void>("cancel_mcp_connectivity_checks", { batchId }) });
      for (const event of early) deliver(event);
      return result;
    } catch (error) { unsubscribe(); throw error; }
  }
  return platform.invoke<T>(command, args);
}
const channelSubscriptions = new Map<string, { unsubscribe: () => void; cancel: () => Promise<void> }>();
export function disposeChannels(): void {
  for (const batch of channelSubscriptions.values()) { batch.unsubscribe(); void batch.cancel().catch(() => undefined); }
  channelSubscriptions.clear();
}
export async function openDirectory(request: DirectoryRequest): Promise<void> { await webPlatform().openDirectory(request); }
export async function openExternal(url: string): Promise<void> {
  const target = new URL(url);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid external URL.");
  const opened = window.open(target.href, "_blank", "noopener,noreferrer");
  // noopener deliberately returns null in some browsers; the browser owns popup policy.
  if (opened) opened.opener = null;
}
export async function pickZip(): Promise<string | null> {
  const platform = webPlatform();
  const { promise, resolve } = Promise.withResolvers<File | null>();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip,application/x-zip-compressed";
  input.hidden = true;
  const finish = (value: File | null) => { input.remove(); resolve(value); };
  input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
  input.addEventListener("cancel", () => finish(null), { once: true });
  document.body.append(input);
  input.click();
  const file = await promise;
  return file ? platform.upload(file) : null;
}
export function availableApps(apps: readonly AppId[]): AppId[] { return apps.filter(isTargetAvailable); }
