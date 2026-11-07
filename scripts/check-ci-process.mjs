import { spawn } from 'node:child_process';
import { constants, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { groupMembers, processIdentity, signalOwnedGroup } from './backend-test-process.mjs';

/** Private append-only records survive a failed/interrupted check and omit argv, env and errors. */
export function createCiRecorder(root, log = message => console.error(message)) {
  const runId = randomUUID();
  let directory = root;
  for (const name of ['.local', 'ci-runs']) {
    directory = path.join(directory, name);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('Cannot create private CI timing directory'); }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CI timing directory must not be a symlink');
  }
  const file = path.join(directory, `${runId}.jsonl`);
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let closed = false, writeFailed = false;
  const record = (kind, label, event, fields = {}) => {
    const value = { version: 1, runId, kind, label, event, at: new Date().toISOString(), ...fields };
    // Telemetry failure must fail the run, but must never prevent owned cleanup.
    if (!writeFailed) {
      try {
        if (closed) throw new Error('Timing artifact is closed');
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Timing artifact write made no progress');
          offset += written;
        }
      } catch {
        writeFailed = true;
        log('[ci] Safe timing artifact write failed; owned cleanup will still run');
      }
    }
    if (event === 'end') log(`[ci:timing] ${JSON.stringify(value)}`);
  };
  const begin = (kind, label) => {
    const started = performance.now();
    record(kind, label, 'start');
    return (fields = { status: 'passed' }) => record(kind, label, 'end', { elapsedMs: Math.round(performance.now() - started), ...fields });
  };
  return {
    file, record, begin,
    get failed() { return writeFailed; },
    async measure(kind, label, operation, interrupted = () => undefined) {
      const finish = begin(kind, label);
      try {
        const value = await operation();
        finish({ status: 'passed' });
        return value;
      } catch (error) {
        const signal = interrupted();
        finish({ status: signal ? 'interrupted' : 'failed', ...(signal ? { signal } : {}) });
        throw error;
      }
    },
    close() {
      if (!closed) { closed = true; closeSync(fd); }
      if (writeFailed) throw new Error('Safe CI timing artifact is incomplete');
    },
  };
}

// Read only numeric kernel counters, never cmdline/environ or potentially secret paths.
async function sampleGroup(group, known) {
  const members = await groupMembers(group);
  if (!members.some(member => known.get(member.pid)?.startTime === member.startTime)) return null;
  known.clear();
  const counters = new Map();
  for (const member of members) {
    known.set(member.pid, member);
    try {
      const stat = readFileSync(`/proc/${member.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[19] !== member.startTime || Number(fields[2]) !== group) continue;
      const io = readFileSync(`/proc/${member.pid}/io`, 'utf8');
      counters.set(`${member.pid}:${member.startTime}`, {
        cpuTicks: Number(fields[11]) + Number(fields[12]),
        readBytes: Number(/^read_bytes: (\d+)$/m.exec(io)?.[1] ?? 0),
        writeBytes: Number(/^write_bytes: (\d+)$/m.exec(io)?.[1] ?? 0),
      });
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return { members: members.length, counters };
}

function activityDelta(previous, current) {
  if (!previous || !current) return {};
  const delta = { cpuTicks: 0, readBytes: 0, writeBytes: 0 };
  for (const [identity, counters] of current.counters) {
    for (const key of Object.keys(delta)) delta[key] += Math.max(0, counters[key] - (previous.counters.get(identity)?.[key] ?? 0));
  }
  return delta;
}

/** Serial commands retain ownership checks and never turn cleanup or a signal into success. */
export function createCiCommandRunner({ cwd, recorder, interrupted = () => undefined, progressInterval = 120_000, shutdownGrace = 10_000, stdout = process.stdout, stderr = process.stderr }) {
  let active;
  function stop(signal, external = true) {
    if (!active) return;
    const command = active;
    if (external) command.requestedSignal = signal;
    else command.internalStop = true;
    const forward = async nextSignal => {
      try {
        if (command.supervised && nextSignal !== 'SIGKILL') command.child.kill(nextSignal);
        else if (command.child.pid && !await signalOwnedGroup(command.child.pid, command.known, nextSignal)) command.stopFailed = true;
      } catch { command.stopFailed = true; }
    };
    void forward(signal);
    if (!command.escalation) command.escalation = setTimeout(() => { void forward('SIGKILL'); }, shutdownGrace + (command.supervised ? 2000 : 0));
  }
  async function run(label, command, args, env, { capture = false, supervised = false, cleanup = false } = {}) {
    if (active) throw new Error('CI commands must run serially');
    if (interrupted() && !cleanup) throw new Error(`CI interrupted by ${interrupted()}`);
    console.error(`[ci] ${label}`);
    const finish = recorder.begin('command', label);
    let child, state, progress, result = { code: null, signal: null }, failure;
    let progressPending = Promise.resolve();
    let previous, outputBytes = 0, previousOutputBytes = 0, lastOutput = performance.now();
    let capturedBytes = 0, overflow = false, spawnFailed = false;
    const chunks = [];
    const started = performance.now();
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const known = new Map();
      if (child.pid) {
        const identity = processIdentity(child.pid);
        if (identity) known.set(child.pid, identity);
      }
      state = active = { child, known, supervised, cleanup, stopFailed: false };
      const completion = new Promise(resolve => {
        child.once('error', () => { spawnFailed = true; resolve({ code: null, signal: null }); });
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const closed = new Promise(resolve => child.once('close', resolve));
      const observe = chunk => { outputBytes += chunk.length; lastOutput = performance.now(); };
      child.stdout.on('data', chunk => {
        observe(chunk);
        if (!capture) return;
        capturedBytes += chunk.length;
        if (capturedBytes <= 4 * 1024 * 1024) chunks.push(chunk);
        else if (!overflow) { overflow = true; stop('SIGTERM', false); }
      });
      child.stderr.on('data', observe).pipe(stderr, { end: false });
      if (!capture) child.stdout.pipe(stdout, { end: false });
      previous = child.pid ? await sampleGroup(child.pid, known).catch(() => null) : null;
      let sampling = false;
      progress = setInterval(() => {
        if (sampling) return;
        sampling = true;
        progressPending = (async () => {
          let current;
          try { current = child.pid ? await sampleGroup(child.pid, known) : null; }
          catch { current = null; }
          const counters = activityDelta(previous, current);
          const fields = {
            elapsedMs: Math.round(performance.now() - started),
            outputIdleMs: Math.round(performance.now() - lastOutput),
            outputBytes: outputBytes - previousOutputBytes,
            ownedProcesses: current?.members ?? null,
            countersAvailable: Boolean(previous && current), ...counters,
          };
          recorder.record('command', label, 'progress', fields);
          console.error(`[ci:progress] ${JSON.stringify({ label, ...fields })}; output may include heartbeats; sampled CPU/I/O is activity, not proof of test progress; no automatic hang kill`);
          previous = current; previousOutputBytes = outputBytes;
        })().catch(() => { state.stopFailed = true; stop('SIGTERM', false); }).finally(() => { sampling = false; });
      }, progressInterval);
      result = await completion;
      await progressPending;
      clearTimeout(state.escalation);
      if (child.pid && (await groupMembers(child.pid)).length) {
        if (!await signalOwnedGroup(child.pid, known, 'SIGTERM')) throw new Error(`${label}: cannot prove surviving process ownership; no unknown process was signalled`);
        const until = performance.now() + shutdownGrace;
        while ((await groupMembers(child.pid)).length && performance.now() < until) await delay(50);
        if ((await groupMembers(child.pid)).length) {
          if (!await signalOwnedGroup(child.pid, known, 'SIGKILL')) throw new Error(`${label}: lost surviving process ownership`);
          const killedUntil = performance.now() + shutdownGrace;
          while ((await groupMembers(child.pid)).length && performance.now() < killedUntil) await delay(50);
          if ((await groupMembers(child.pid)).length) throw new Error(`${label}: owned processes survived cleanup`);
        }
        throw new Error(`${label} left live owned descendants`);
      }
      await closed;
      if (spawnFailed) throw new Error(`${label} could not start`);
      if (overflow) throw new Error(`${label} exceeded the bounded capture limit`);
      if (state.stopFailed) throw new Error(`${label} signalling or diagnostics failed`);
      if (result.code !== 0 || result.signal) throw new Error(`${label} failed (${result.signal ?? result.code})`);
      if (interrupted() && !cleanup) throw new Error(`CI interrupted by ${interrupted()}`);
      return Buffer.concat(chunks).toString('utf8').trim();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      clearInterval(progress);
      await progressPending;
      if (state) clearTimeout(state.escalation);
      if (failure) { child?.stdout?.destroy(); child?.stderr?.destroy(); }
      active = undefined;
      const signal = result.signal ?? state?.requestedSignal ?? (!cleanup ? interrupted() : undefined);
      finish({ status: failure ? state?.internalStop ? 'failed' : signal ? 'interrupted' : 'failed' : 'passed', code: result.code, signal: signal ?? null });
    }
  }
  return { run, stop };
}
