/** Translated from apps/server/cc-switch-host/src/main.rs. */
import { createInterface } from "node:readline";
import { Host } from "./host.ts";
import { publicErrorCode } from "./errors.ts";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_PENDING = 256;

interface Request {
  id: string;
  command: string;
  args: Record<string, unknown>;
}

function parseRequest(line: string): Request | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.id !== "string" || object.id.length === 0 || object.id.length > MAX_ID_LENGTH) return undefined;
  if (typeof object.command !== "string" || object.command.length === 0) return undefined;
  const args = object.args ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { id: object.id, command: object.command, args: args as Record<string, unknown> };
}

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let host: Host | undefined;
let stopping = false;
let initializing = false;
let inputClosed = false;
const queued: string[] = [];
const pending = new Set<Promise<void>>();

process.on("uncaughtException", (error) => {
  process.stderr.write(`cc-switch-host invariant failure (details redacted): ${error instanceof Error ? error.name : "unknown"}\n`);
  process.exit(1);
});
process.on("unhandledRejection", () => {
  process.stderr.write("cc-switch-host invariant failure (details redacted): unhandled rejection\n");
  process.exit(1);
});

function maybeFinish(): void {
  if (!inputClosed || initializing || pending.size > 0) return;
  stopping = true;
  host?.close();
  process.exit(0);
}

function track(promise: Promise<void>): void {
  let task: Promise<void>;
  task = promise.finally(() => {
    pending.delete(task);
    maybeFinish();
  });
  pending.add(task);
}

function handleLine(line: string): void {
  if (stopping) return;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    write({ id: "", error: { code: "INVALID_REQUEST", message: "Invalid private host request" } });
    return;
  }
  const request = parseRequest(line);
  if (!request) {
    write({ id: "", error: { code: "INVALID_REQUEST", message: "Invalid private host request" } });
    return;
  }
  if (!host) {
    if (request.command !== "host_initialize") {
      write({ id: request.id, error: { code: "NOT_INITIALIZED", message: "host_initialize must be the first command" } });
      return;
    }
    initializing = true;
    track(Host.initialize(request.args, write).then(
      (initialized) => {
        host = initialized;
        initializing = false;
        write({ id: request.id, result: { initialized: true, apps: initialized.apps } });
        const next = queued.splice(0);
        for (const queuedLine of next) handleLine(queuedLine);
        maybeFinish();
      },
      () => {
        initializing = false;
        write({ id: request.id, error: { code: "INITIALIZATION_FAILED", message: "Context initialization failed; verify bound paths, ownership, schema and key" } });
        stopping = true;
        lines.close();
      },
    ));
    return;
  }
  if (pending.size >= MAX_PENDING) {
    write({ id: request.id, error: { code: "COMMAND_FAILED", message: "Management operation failed; authoritative state may be partially updated" } });
    return;
  }
  track(host.invoke(request).then(
    (result) => { if (!stopping) write({ id: request.id, result }); },
    (error) => { if (!stopping) write({ id: request.id, error: { code: publicErrorCode(error), message: "Management operation failed; authoritative state may be partially updated" } }); },
  ));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  if (initializing) {
    queued.push(line);
    return;
  }
  handleLine(line);
});

lines.on("close", () => {
  inputClosed = true;
  // All complete lines were already delivered before EOF. Let initialization
  // and those requests settle, then release the context lock and exit.
  maybeFinish();
});
