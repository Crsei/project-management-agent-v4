// ACP auth discovery/terminal/elicitation behavior ported from t3code
// packages/provider-acp-registry/src/server/{auth,probe}.ts (MIT).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as pty from "@lydell/node-pty";
import type { ProviderAuthMethod } from "@agent-workspace/contracts/provider";
import type { ProviderDriverAuthOptions, ProviderDriverContext } from "../driver-adapter.ts";
import { sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import { AcpError, acpRecord, openAcpClient, type AcpClient, type AcpClientOptions, type AcpRecord, type AcpSpawn } from "./acp.ts";

export function acpAuthMethods(initialized: AcpRecord): ProviderAuthMethod[] {
  if (!Array.isArray(initialized.authMethods)) return [];
  return initialized.authMethods.slice(0, 32).map(acpRecord).flatMap((method): ProviderAuthMethod[] => {
    const id = method.id ?? method.methodId;
    if (typeof id !== "string" || !id.trim() || id.length > 128) return [];
    const variables = Array.isArray(method.vars) ? method.vars.map(acpRecord).filter((variable) => typeof variable.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)).slice(0, 16) : [];
    return [{ id, name: typeof method.name === "string" ? method.name.slice(0, 160) : id, ...(typeof method.description === "string" ? { description: method.description.slice(0, 1024) } : {}), type: method.type === "env_var" ? "credentials" : method.type === "terminal" ? "terminal" : "browser", ...(method.type === "env_var" ? { fields: variables.map((variable) => ({ name: String(variable.name), label: String(variable.label ?? variable.name), secret: true })) } : {}) }];
  });
}
export function acpAuthenticationBinding(context: ProviderDriverContext): string {
  const config = Object.entries(context.config).sort(([a], [b]) => a.localeCompare(b));
  const environment = Object.entries(context.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([context.instanceId, context.driver, config, environment])).digest("hex");
}
function credentialPath(context: ProviderDriverContext): string {
  const binding = acpAuthenticationBinding(context).slice(0, 24);
  return path.join(context.homeDirectory, `.acp-credentials-${binding}.json`);
}
export async function acpCredentialEnvironment(context: ProviderDriverContext): Promise<NodeJS.ProcessEnv> {
  try {
    const parsed = acpRecord(JSON.parse(await readFile(credentialPath(context), "utf8")));
    const environment: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(parsed)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" && !/^(?:HOME|USERPROFILE|GROK_HOME|PATH|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*)$/.test(name)) environment[name] = value;
    return environment;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new AcpError("Could not read this instance's ACP credentials."); }
}
export async function clearAcpCredentials(context: ProviderDriverContext): Promise<void> { await rm(credentialPath(context), { force: true }); }
export async function saveAcpCredentials(context: ProviderDriverContext, credentials: Record<string, string>): Promise<void> {
  for (const name of Object.keys(credentials)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(?:HOME|USERPROFILE|GROK_HOME|PATH|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*)$/.test(name)) throw new AcpError("ACP credentials cannot override home, executable search, or loader configuration.");
  }
  await mkdir(context.homeDirectory, { recursive: true, mode: 0o700 });
  const destination = credentialPath(context); const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 }); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
}

/** Agent URLs are displayed, never fetched/opened by the server. */
export function acpAuthenticationRequest(options: ProviderDriverAuthOptions, generation: () => 1 | 2): (method: string, params: AcpRecord) => Promise<unknown> {
  return async (method, params) => {
    if (!["elicitation/create", "session/elicitation", "_session/elicitation", "session/elicitation/create"].includes(method)) throw new AcpError(`Unsupported ACP authentication request: ${method}.`, -32601);
    const id = typeof params.elicitationId === "string" ? params.elicitationId : randomUUID();
    const result = (value: AcpRecord): AcpRecord => generation() === 1 && method !== "elicitation/create" ? { action: value } : value;
    if (params.mode === "url" && typeof params.url === "string") {
      const url = new URL(params.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new AcpError("ACP authentication returned an unsafe browser URL.");
      options.onUpdate({ phase: "waiting", interaction: { type: "browser", id, url: url.href, requiresConsent: true }, ...(typeof params.message === "string" ? { message: params.message } : {}) });
      // URL elicitations are consent requests; explicit acknowledgement comes from the UI.
      const input = await options.readInput();
      if (options.signal.aborted) throw new DOMException("Authentication cancelled.", "AbortError");
      if (/^(?:cancel|decline|no)$/i.test(input.trim())) return result({ action: "decline" });
      return result({ action: "accept" });
    }
    const schema = acpRecord(params.requestedSchema);
    const properties = acpRecord(schema.properties);
    const fields = Object.entries(properties).slice(0, 32).map(([name, value]) => ({ name, label: typeof acpRecord(value).title === "string" ? String(acpRecord(value).title) : name, secret: /password|token|secret|key/i.test(name) || acpRecord(value).format === "password" }));
    if (!fields.length) throw new AcpError("ACP authentication requested an unsupported form.");
    options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id, fields } });
    let values: AcpRecord;
    try { values = acpRecord(JSON.parse(await options.readInput())); } catch { throw new AcpError("ACP authentication expects a credential form response."); }
    const content: AcpRecord = {};
    for (const field of fields) {
      const property = acpRecord(properties[field.name]); const value = values[field.name];
      if (typeof value !== "string") continue;
      if (property.type === "boolean") content[field.name] = value === "true";
      else if (property.type === "number" || property.type === "integer") { const number = Number(value); if (!Number.isFinite(number)) throw new AcpError(`Invalid numeric authentication field ${field.name}.`); content[field.name] = number; }
      else content[field.name] = value;
    }
    return result({ action: "accept", content });
  };
}

async function terminalLogin(context: ProviderDriverContext, spawnInput: AcpSpawn, method: AcpRecord, options: ProviderDriverAuthOptions): Promise<void> {
  const methodEnvironment: Record<string, string> = {};
  const entries = Array.isArray(method.env) ? method.env.map(acpRecord).map((value) => [value.name, value.value]) : Object.entries(acpRecord(method.env));
  for (const [name, value] of entries) if (typeof name === "string" && typeof value === "string" && !["HOME", "USERPROFILE", "GROK_HOME"].includes(name)) methodEnvironment[name] = value;
  const args = Array.isArray(method.args) && method.args.every((arg) => typeof arg === "string") ? method.args as string[] : [];
  const env = Object.fromEntries(Object.entries({ ...context.env, ...spawnInput.env, ...methodEnvironment }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const process = pty.spawn(spawnInput.command, [...spawnInput.args, ...args], { cwd: context.cwd, env, cols: 100, rows: 30, name: "xterm-256color" });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let finished = false;
  const abort = () => { try { process.kill(); } catch { /* Already exited. */ } reject(new DOMException("ACP authentication cancelled.", "AbortError")); };
  const output = process.onData((data) => options.onUpdate({ phase: "waiting", interaction: { type: "terminal", id: "acp-terminal", output: sanitizeErrorMessage(data, "") }, output: sanitizeErrorMessage(data, "") }));
  const exit = process.onExit(({ exitCode }) => { finished = true; if (exitCode === 0) resolve(); else reject(new AcpError(`ACP terminal authentication exited with code ${exitCode}.`)); });
  const timer = setTimeout(() => { try { process.kill(); } catch { /* Already exited. */ } reject(new AcpError("ACP terminal authentication timed out.")); }, 10 * 60_000);
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const input = async () => { while (!finished && !options.signal.aborted) { const value = await options.readInput(); if (!finished) process.write(value); } };
  void input().catch((error) => { if (!finished && !options.signal.aborted) reject(error); });
  try { await promise; } finally { finished = true; clearTimeout(timer); options.signal.removeEventListener("abort", abort); output.dispose(); exit.dispose(); try { process.kill(); } catch { /* Already exited. */ } }
}

export async function authenticateAcp(context: ProviderDriverContext, spawnInput: AcpSpawn, options: ProviderDriverAuthOptions, clientOptions: AcpClientOptions = {}): Promise<void> {
  let client: AcpClient | undefined;
  const make = async (extraEnv: NodeJS.ProcessEnv = {}) => {
    const instance: AcpClient = await openAcpClient(context, { ...spawnInput, env: { ...spawnInput.env, ...extraEnv } }, { ...clientOptions, signal: options.signal, onRequest: acpAuthenticationRequest(options, () => instance.generation) });
    return instance;
  };
  try {
    client = await make(await acpCredentialEnvironment(context));
    const initialized = await client.initialize();
    const methods = acpAuthMethods(initialized);
    const methodId = options.methodId || String(context.config.authMethodId || "") || methods.find((method) => method.type === "browser")?.id || methods[0]?.id;
    const method = Array.isArray(initialized.authMethods) ? initialized.authMethods.map(acpRecord).find((candidate) => candidate.id === methodId) : undefined;
    if (!methodId || !method) throw new AcpError("Select an authentication method advertised by this ACP agent.");
    if (method.type === "terminal") {
      client.close(); await client.waitForClose(); client = undefined;
      await terminalLogin(context, spawnInput, method, options);
      client = await make(await acpCredentialEnvironment(context));
    } else if (method.type === "env_var") {
      const fields = methods.find((candidate) => candidate.id === methodId)?.fields ?? [];
      if (!fields.length) throw new AcpError("ACP credential method did not advertise environment fields.");
      let values = options.values;
      if (!values || fields.some((field) => !values?.[field.name])) {
        options.onUpdate({ phase: "waiting", interaction: { type: "credentials", id: methodId, fields } });
        try { values = acpRecord(JSON.parse(await options.readInput())) as Record<string, string>; } catch { throw new AcpError("Invalid ACP credential response."); }
      }
      const credentials: Record<string, string> = {};
      for (const field of fields) {
        if (/^(?:HOME|USERPROFILE|GROK_HOME|PATH|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*)$/.test(field.name)) throw new AcpError("ACP credential method requests a protected environment variable.");
        const value = values[field.name]; if (typeof value !== "string" || !value.trim()) throw new AcpError(`Missing credential ${field.label}.`); credentials[field.name] = value;
      }
      client.close(); await client.waitForClose(); client = await make(credentials);
      await client.initialize(); await client.start();
      await saveAcpCredentials(context, credentials);
      return;
    } else await client.authenticate(methodId);
    options.onUpdate({ phase: "verifying", interaction: null });
    await client.start(); // An RPC acknowledgement alone is not proof of usable login.
  } finally { if (client) { client.close(); await client.waitForClose(); } }
}
