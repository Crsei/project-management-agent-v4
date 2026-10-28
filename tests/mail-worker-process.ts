/// <reference lib="es2024.promise" />
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AccountRecoveryMailConfig } from '../packages/infrastructure/src/account-recovery-mail.ts';
import type { InvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const lifecycleEvents: Record<string, true> = {
  worker_started: true, worker_stopped: true, worker_cycle_failed: true, invitation_mail_cycle_failed: true,
  account_recovery_mail_cycle_failed: true, notification_cycle_failed: true, automation_cycle_failed: true,
  webhook_cycle_failed: true, database_pool_error: true,
};
const startupMessages: Record<string, true> = {
  'Worker must not receive blob credentials or ambient cloud identity': true,
  'DATABASE_URL is required for the Worker': true, 'Run migrations before starting the Worker': true,
  'System SMTP configuration is incomplete or invalid': true, 'Mail feature configuration is incomplete or invalid': true,
  'Invitation mail configuration is incomplete or invalid': true, 'Account recovery mail configuration is incomplete or invalid': true,
  'Invalid WORKER_INTERVAL_MS': true, 'Invalid EVENT_RETENTION_DAYS': true, 'Invalid local project configuration': true,
  'LOCAL_PROJECT_ALLOWED_ROOTS must be a JSON array of absolute paths': true,
  'Local projects require at least one trusted allowed root': true,
};
const errorCodes: Record<string, true> = { ENOENT: true, EACCES: true, EPERM: true, EAGAIN: true, ENOMEM: true, ESRCH: true, ECONNREFUSED: true, ENOTFOUND: true };
const diagnosticLimit = 32;
const lineLimit = 4096;

/** Only OS execution settings and this fixture's configuration reach the child. */
export function mailWorkerEnvironment(input: {
  databaseUrl: string; coreRoot: string; invitationMail?: InvitationMailConfig; recoveryMail?: AccountRecoveryMailConfig;
}, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'CHOKIDAR_USEPOLLING']) {
    if (ambient[key] !== undefined) env[key] = ambient[key];
  }
  Object.assign(env, {
    DATABASE_URL: input.databaseUrl, CORE_WORKSPACE_ROOT: input.coreRoot,
    LOCAL_PROJECT_CONFIG: join(input.coreRoot, 'missing-test-config.json'), LOCAL_PROJECTS_ENABLED: 'false',
    LOCAL_PROJECT_ALLOWED_ROOTS: '[]', LOCAL_DATA_ROOT: dirname(input.coreRoot),
    WORKER_INTERVAL_MS: '25', EVENT_RETENTION_DAYS: '3650',
  });
  const smtp = input.invitationMail ?? input.recoveryMail;
  if (smtp) Object.assign(env, {
    SMTP_HOST: smtp.host, SMTP_PORT: String(smtp.port), SMTP_SECURE: String(smtp.secure),
    SMTP_REQUIRE_TLS: String(smtp.requireTls ?? true), SMTP_FROM: smtp.from,
    SMTP_TIMEOUT_MS: String(smtp.timeoutMs), ...(smtp.auth ? { SMTP_USER: smtp.auth.user, SMTP_PASSWORD: smtp.auth.pass } : {}),
  });
  if (input.invitationMail) Object.assign(env, {
    INVITATION_WEB_ORIGIN: input.invitationMail.webOrigin,
    INVITATION_TOKEN_KEY: input.invitationMail.tokenKey.toString('base64'),
    INVITATION_TTL_SECONDS: String(input.invitationMail.ttlSeconds),
  });
  if (input.recoveryMail) Object.assign(env, {
    ACCOUNT_RECOVERY_WEB_ORIGIN: input.recoveryMail.webOrigin,
    ACCOUNT_RECOVERY_TOKEN_KEY: input.recoveryMail.tokenKey.toString('base64'),
    PASSWORD_RESET_TTL_SECONDS: String(input.recoveryMail.resetTtlSeconds),
    RECOVERY_EMAIL_VERIFY_TTL_SECONDS: String(input.recoveryMail.verifyTtlSeconds),
  });
  return env;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; forced: boolean };
type Termination = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'spawn'; code: string };
export type OwnedMailWorker = {
  until(check: () => Promise<boolean> | boolean, label: string, timeoutMs?: number): Promise<void>;
  stop(deadlines?: { graceMs?: number; killMs?: number }): Promise<Exit>;
  diagnostics(): string;
  hasEvent(event: string): boolean;
};

/** Owns only the returned ChildProcess, never a PID lookup or an existing service. */
export function startOwnedMailWorker(options: {
  env: NodeJS.ProcessEnv; signal?: AbortSignal; executable?: string; args?: string[];
}): OwnedMailWorker {
  options.signal?.throwIfAborted();
  const child = spawn(options.executable ?? process.execPath, options.args ?? ['apps/worker/src/main.ts'], {
    cwd: projectRoot, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics: string[] = [];
  const events = new Set<string>();
  let termination: Termination | undefined;
  let exitResult: Exit | undefined;
  let forced = false;
  const terminal = Promise.withResolvers<Termination>();
  const closed = Promise.withResolvers<Exit>();
  function record(stream: string, text: string) {
    diagnostics.push(`${stream}: ${text}`);
    if (diagnostics.length > diagnosticLimit) diagnostics.shift();
  }
  function safeLine(stream: string, line: string) {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && 'event' in value && typeof value.event === 'string' && Object.hasOwn(lifecycleEvents, value.event)) {
        events.add(value.event);
        const failures = 'consecutiveFailures' in value && Number.isSafeInteger(value.consecutiveFailures) && Number(value.consecutiveFailures) >= 0
          ? ` consecutiveFailures=${value.consecutiveFailures}` : '';
        record(stream, `${value.event}${failures}`);
        return;
      }
    } catch { /* Raw JSON fields, source excerpts and stack messages are never retained. */ }
    const error = /^(Error|TypeError|SyntaxError|RangeError|ReferenceError):(?: (.*))?$/.exec(line.trim());
    if (error) record(stream, Object.hasOwn(startupMessages, error[2] ?? '') ? `${error[1]}: ${error[2]}` : `${error[1]}: [message redacted]`);
    else record(stream, '[output redacted]');
  }
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    let pending = '';
    let oversized = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      for (const part of chunk.split(/(?<=\n)/)) {
        const complete = part.endsWith('\n');
        if (!oversized && pending.length + part.length <= lineLimit) pending += part;
        else oversized = true;
        if (complete) {
          if (oversized) record(name, '[oversized output redacted]');
          else safeLine(name, pending);
          pending = ''; oversized = false;
        }
      }
    });
    stream.once('end', () => {
      if (oversized) record(name, '[oversized output redacted]');
      else safeLine(name, pending);
      pending = '';
    });
  }
  // Attach both terminal listeners now, before callers can send any signal.
  child.once('error', error => {
    const code = (error as NodeJS.ErrnoException).code;
    termination ??= { kind: 'spawn', code: code && Object.hasOwn(errorCodes, code) ? code : 'spawn_failed' };
    terminal.resolve(termination);
  });
  child.once('exit', (code, signal) => {
    termination ??= { kind: 'exit', code, signal };
    terminal.resolve(termination);
  });
  child.once('close', (code, signal) => {
    exitResult = { code, signal, forced };
    options.signal?.removeEventListener('abort', onAbort);
    closed.resolve(exitResult);
  });
  function diagnosticText() { return diagnostics.join('\n') || '[no safe child diagnostics]'; }
  function failure(label: string) {
    const reason = termination?.kind === 'spawn' ? `failed to spawn (${termination.code})`
      : termination?.kind === 'exit' ? `exited code=${termination.code} signal=${termination.signal}` : 'stopped';
    return new Error(`Owned Worker ${reason} before ${label}\n${diagnosticText()}`);
  }
  async function until(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) {
    options.signal?.throwIfAborted();
    if (termination) throw failure(label);
    const loop = new AbortController();
    const aborted = Promise.withResolvers<never>();
    const deadline = Promise.withResolvers<never>();
    const onWaitAbort = () => aborted.reject(new Error(`Owned Worker observation cancelled before ${label}\n${diagnosticText()}`));
    options.signal?.addEventListener('abort', onWaitAbort, { once: true });
    if (options.signal?.aborted) onWaitAbort();
    const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${label}\n${diagnosticText()}`)), timeoutMs);
    try {
      await Promise.race([
        (async () => {
          while (!loop.signal.aborted) {
            const ready = await check();
            if (loop.signal.aborted) return;
            if (termination) throw failure(label);
            if (ready) return;
            await delay(25, undefined, { signal: loop.signal }).catch(() => {});
          }
        })(),
        terminal.promise.then(() => { throw failure(label); }),
        deadline.promise,
        aborted.promise,
      ]);
    } finally {
      loop.abort(); clearTimeout(timer);
      options.signal?.removeEventListener('abort', onWaitAbort);
    }
  }
  async function waitForClose(timeoutMs: number): Promise<Exit | undefined> {
    const deadline = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => deadline.resolve(undefined), timeoutMs);
    try {
      return await Promise.race([closed.promise, deadline.promise]);
    } finally { clearTimeout(timer); }
  }
  let stopping: Promise<Exit> | undefined;
  function stop(deadlines: { graceMs?: number; killMs?: number } = {}): Promise<Exit> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (exitResult) return exitResult;
      if (!termination) child.kill('SIGTERM');
      const graceful = await waitForClose(deadlines.graceMs ?? 10_000);
      if (graceful) return graceful;
      if (!termination) { forced = true; child.kill('SIGKILL'); }
      const killed = await waitForClose(deadlines.killMs ?? 5_000);
      if (killed) return killed;
      throw new Error(`Owned Worker did not close within its bounded shutdown deadlines\n${diagnosticText()}`);
    })();
    return stopping;
  }
  function onAbort() { void stop().catch(() => {}); }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return { until, stop, diagnostics: diagnosticText, hasEvent: (event: string) => events.has(event) };
}
