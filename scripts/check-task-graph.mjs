// Native package scripts are the only command implementations. Root tasks use
// //# explicitly so a package's build/lint never discovers a root aggregate.
const task = (qualifiedTask, stage, label, args, outputRoots = []) => Object.freeze({
  task: qualifiedTask,
  stage,
  label,
  command: 'pnpm',
  args: Object.freeze(args),
  cache: true,
  // Root-relative directories exclusively owned by this leaf. The runner
  // validates and clears them before baseline execution or native restoration.
  outputRoots: Object.freeze(outputRoots),
});

export const CHECK_TASKS = Object.freeze({
  'lint:pm': task('//#lint', 'lint', 'PM lint', ['lint']),
  'lint:gateway': task('//#lint:gateway', 'lint', 'Gateway lint', ['lint:gateway']),
  'lint:agent': task('//#lint:agent', 'lint', 'Agent and host lint', ['lint:agent']),
  'lint:web': task('@pm/web#lint', 'lint', 'Complete owned Web lint', ['--filter', '@pm/web', 'lint']),
  'lint:ci': task('//#lint:ci', 'lint', 'CI entrypoint lint', ['lint:ci']),
  'lint:upstream': task('//#lint:upstream', 'lint', 'Upstream tooling lint', ['lint:upstream']),
  'build:contracts': task('@agent-workspace/contracts#build', 'build', 'Agent contract declarations', ['--filter', '@agent-workspace/contracts', 'build'], ['packages/agent-contracts/dist']),
  'build:client': task('@agent-workspace/client-runtime#build', 'build', 'Agent client runtime declarations', ['--filter', '@agent-workspace/client-runtime', 'build'], ['packages/agent-client-runtime/dist']),
  'build:client-types': task('@agent-workspace/client-runtime#typecheck', 'build', 'Complete client runtime types, including tests and provider exports', ['--filter', '@agent-workspace/client-runtime', 'typecheck']),
  'build:pm-types': task('//#typecheck', 'build', 'PM and gateway typecheck', ['typecheck']),
  'build:pm': task('//#build', 'build', 'PM production build', ['build'], ['dist']),
  'build:agent': task('@agent-workspace/server#build', 'build', 'Agent complete types and production build', ['--filter', '@agent-workspace/server', 'build'], ['apps/server/agent/dist']),
  'build:web': task('@pm/web#build', 'build', 'Complete Web types and production build', ['--filter', '@pm/web', 'build'], ['apps/web/dist']),
  'build:marketing-types': task('@agent-workspace/marketing#typecheck', 'build', 'Marketing types', ['--filter', '@agent-workspace/marketing', 'typecheck']),
  'build:marketing': task('@agent-workspace/marketing#build', 'build', 'Marketing production build', ['--filter', '@agent-workspace/marketing', 'build'], ['apps/marketing/.astro', 'apps/marketing/dist']),
  'host:build': task('@agent-workspace/cc-switch-host#build', 'host-build', 'TypeScript host build', ['--filter', '@agent-workspace/cc-switch-host', 'build'], ['apps/server/cc-switch-host/dist']),
});

// The order is also the direct baseline order. The native graph encodes the
// build chain separately; lint scopes and the standalone host build are leaves.
export const CHECK_STAGES = Object.freeze({
  lint: Object.freeze([
    'lint:pm',
    'lint:gateway',
    'lint:agent',
    'lint:web',
    'lint:ci',
    'lint:upstream',
  ]),
  build: Object.freeze([
    'build:contracts',
    'build:client',
    'build:client-types',
    'build:pm-types',
    'build:pm',
    'build:agent',
    'build:web',
    'build:marketing-types',
    'build:marketing',
  ]),
  'host-build': Object.freeze(['host:build']),
});
