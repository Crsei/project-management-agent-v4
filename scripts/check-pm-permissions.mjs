import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: node scripts/check-pm-permissions.mjs [--phase offline|unit|protocol|real-db] [--list]';
let interrupted;
let commandRunner;
const stop = signal => { interrupted ??= signal; commandRunner?.stop(signal); };
const sigint = () => stop('SIGINT');
const sigterm = () => stop('SIGTERM');

async function main() {
  let phase = 'offline', selected = false, list = false;
  const args = process.argv.slice(2);
  while (args.length) {
    const argument = args.shift();
    if (argument === '--phase' && !selected) {
      phase = args.shift();
      if (!['offline', 'unit', 'protocol', 'real-db'].includes(phase)) throw new Error(usage);
      selected = true;
    } else if (argument === '--list' && !list) list = true;
    else throw new Error(usage);
  }
  const manifest = JSON.parse(await readFile(new URL('./pm-permission-checks.json', import.meta.url), 'utf8'));
  if (manifest.version !== 1) throw new Error('Unsupported permission selection manifest version');
  const phases = phase === 'offline' ? ['unit', 'protocol'] : [phase];
  if (list) {
    for (const name of phases) {
      const selection = manifest.phases[name];
      console.log(`[pm-permissions:${name}] ${selection.proof}`);
      for (const file of selection.files ?? []) console.log(file);
      if (selection.entry) console.log(`node ${selection.entry} ${selection.args.join(' ')}`);
    }
    for (const item of manifest.externalProof) console.log(`[pm-permissions:${item.phase}] external evidence required: ${item.requiredEvidence}`);
    return;
  }
  if (process.platform !== 'linux') throw new Error('Permission checks reuse Linux procfs and util-linux flock supervision');
  // Native fixtures bind Unix sockets; a caller's long TMPDIR can exceed sun_path.
  const temporary = await mkdtemp('/tmp/dovspace-perm-');
  let recorder;
  let failure;
  try {
    // Whitelist, rather than copy, the caller environment. No .env, live API/DB
    // address, service secret, OAuth token, provider account or global client home.
    const env = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: path.join(temporary, 'home'), TMPDIR: path.join(temporary, 'tmp'),
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      AGENT_WORKSPACE_DATA_DIR: path.join(temporary, 'agent'), PM_CHAT_SPACE_ROOT: path.join(temporary, 'chat-space'),
      PM_CLI_SESSION_DIR: path.join(temporary, 'cli-sessions'),
      PM_API_URL: 'http://127.0.0.1:1', PM_MCP_AGENT_URL: 'http://127.0.0.1:1',
      CI: 'true', DOVSPACE_ISOLATED_CHECKS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
      NODE_OPTIONS: '--conditions=development --max-old-space-size=4096', CHOKIDAR_USEPOLLING: 'true',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Dovspace CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'Dovspace CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid',
      AWS_EC2_METADATA_DISABLED: 'true',
    };
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'AGENT_WORKSPACE_DATA_DIR', 'PM_CHAT_SPACE_ROOT', 'PM_CLI_SESSION_DIR']) {
      await mkdir(env[key], { mode: 0o700 });
    }
    await access('/usr/bin/flock');
    recorder = createCiRecorder(root);
    recorder.record('run', 'PM permission regressions', 'scope', { phase, registry: manifest.registry });
    console.error(`[pm-permissions] Private check evidence: ${path.relative(root, recorder.file)}`);
    commandRunner = createCiCommandRunner({ cwd: root, recorder, interrupted: () => interrupted });
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
    for (const name of phases) {
      const selection = manifest.phases[name];
      console.error(`[pm-permissions:${name}] ${selection.proof}`);
      const command = selection.files
        ? ['scripts/backend-tests.mjs', 'files', '--', ...selection.files]
        : [selection.entry, ...selection.args];
      // Existing supervisor requires every file to finish with a complete Node
      // test summary; skipped/cancelled/todo cases are failures, not green proof.
      await commandRunner.run(`PM permission ${name}`, process.execPath, command, env, { supervised: true });
    }
    recorder.record('run', 'PM permission regressions', 'end', { status: 'passed', phase });
    console.error(`[pm-permissions] Selected ${phase} checks passed only; ${['unit', 'protocol', 'real-db', 'browser', 'client'].filter(name => !phases.includes(name)).join(', ')} proof NOT RUN.`);
  } catch (error) {
    failure = error;
    recorder?.record('run', 'PM permission regressions', 'end', { status: interrupted ? 'interrupted' : 'failed', phase });
  } finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    try { await rm(temporary, { recursive: true, force: true }); }
    catch (error) { failure ??= error; }
    try { recorder?.close(); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

try { await main(); }
catch (error) {
  console.error(`[pm-permissions] ${error instanceof Error ? error.message : 'Permission checks failed'}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
}
