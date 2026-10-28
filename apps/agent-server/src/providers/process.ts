import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type ProviderProcessContext = { executable?: string; cwd?: string; env?: NodeJS.ProcessEnv };
type CommandResult = { installed: boolean; code: number | null; stdout: string; stderr: string };
export function runProviderCommand(
  command: string,
  args: string[],
  options: ProviderProcessContext & {
    timeoutMs?: number;
    maxOutput?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ installed: boolean; code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  let settled = false;
  let stdout = "";
  let stderr = "";
  const max = options.maxOutput ?? 512 * 1024;
  const child = spawn(options.executable || command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  const finish = (installed: boolean, code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    stdout = (stdout + outDecoder.end()).slice(0, max);
    stderr = (stderr + errDecoder.end()).slice(0, max);
    resolve({ installed, code, stdout, stderr });
  };
  const abort = () => {
    child.kill("SIGKILL");
    finish(true, null);
  };
  const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + outDecoder.write(chunk)).slice(0, max);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + errDecoder.write(chunk)).slice(0, max);
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    stderr = error.message;
    finish(error.code !== "ENOENT", null);
  });
  child.once("close", (code) => finish(true, code));
  if (options.signal?.aborted) abort();
  return promise;
}
