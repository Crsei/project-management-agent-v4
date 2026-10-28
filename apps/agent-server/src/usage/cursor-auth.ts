// Adapted from t3code CursorKeychain.ts and usageLimits.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StoredProviderInstance } from "../providers/instances.ts";

const exec = promisify(execFile);
export const CURSOR_ENDPOINT = "https://api2.cursor.sh";
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export async function readInstanceFile(home: string, file: string): Promise<string> {
  const [root, resolved] = await Promise.all([realpath(home), realpath(file)]);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Credential path is outside its instance home");
  return readFile(resolved, "utf8");
}
export function cursorAccount(token: string): { account: string; userId: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const userId = payload.sub.split("|").at(-1);
    return userId ? { account: hash(payload.sub), userId } : null;
  } catch { return null; }
}
export function cursorEndpoint(instance: StoredProviderInstance): string {
  const raw = String(instance.config.apiEndpoint || instance.env.CURSOR_API_ENDPOINT || CURSOR_ENDPOINT).trim().replace(/\/$/, "");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid Cursor endpoint");
  return raw;
}
let keychainRead: Promise<string | null> | undefined;
let cachedKeychain: { token: string; until: number } | undefined;
async function keychain(): Promise<string | null> {
  if (cachedKeychain && cachedKeychain.until > Date.now()) return cachedKeychain.token;
  if (!keychainRead) {
    keychainRead = exec("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], { timeout: 30_000, maxBuffer: 64_000 }).then(({ stdout }) => {
      const token = stdout.trim() || null;
      if (token) cachedKeychain = { token, until: Date.now() + 300_000 };
      return token;
    }).finally(() => { keychainRead = undefined; });
  }
  return keychainRead;
}
export async function cursorCredential(instance: StoredProviderInstance, allowKeychain: boolean): Promise<{ token: string | null; message?: string; keychain?: boolean }> {
  const env = instance.env;
  if (env.CURSOR_AUTH_TOKEN?.trim()) return { token: env.CURSOR_AUTH_TOKEN.trim() };
  if (env.CURSOR_API_KEY?.trim()) return { token: null, message: "Cursor account usage is unavailable for API keys." };
  if (env.AGENT_CLI_CREDENTIAL_STORE === "memory") return { token: null, message: "Cursor account usage requires a persisted CLI login." };
  if (process.platform === "darwin" && env.AGENT_CLI_CREDENTIAL_STORE !== "file") {
    if (!allowKeychain) return { token: null, message: "Enable Cursor account usage to read its Keychain login.", keychain: true };
    if (cursorEndpoint(instance) !== CURSOR_ENDPOINT) return { token: null, message: "Cursor Keychain requires the default endpoint.", keychain: true };
    return { token: await keychain(), keychain: true };
  }
  const home = instance.homeDirectory;
  const file = process.platform === "win32" ? path.join(home, "AppData", "Roaming", "Cursor", "auth.json") : process.platform === "darwin" ? path.join(home, ".cursor", "auth.json") : path.join(home, ".config", "cursor", "auth.json");
  try {
    const parsed = JSON.parse(await readInstanceFile(home, file));
    return { token: typeof parsed.accessToken === "string" ? parsed.accessToken.trim() || null : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { token: null };
    throw error;
  }
}
