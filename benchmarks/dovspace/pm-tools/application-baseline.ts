import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../../../packages/pm-core/index.ts';
import { readTaskBrief } from '../../../packages/application/src/task-brief.ts';
import { STANDARD_BODY, LONG_BODY, HEADING_BODY, PM_CORPUS_VERSION, corpusSemanticHash } from './corpus.ts';
import { measureBriefBytes } from './measurement.ts';

/** No-model, no-network before-fix measurement using real Markdown authority and the current application service. Not HTTP, OMP or model evidence. */
export async function measureApplicationBaseline() {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-pm-tool-measurement-'));
  const workspace = new Workspace(root);
  try {
    await workspace.init();
    const project = await workspace.createEntity({ entity: 'project', title: 'Migration control' });
    const measurements = [];
    for (const [name, body] of Object.entries({ standard: STANDARD_BODY, long: LONG_BODY, headings: HEADING_BODY })) {
      const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: name, body });
      const context = { workspaceId: '33333333-3333-4333-8333-333333333333', authorizationKey: 'synthetic-current-actor', records: workspace.snapshot().files, relations: workspace.graph({ archived: 'include' }).links, now: new Date('2026-11-13T00:00:00Z') };
      const start = performance.now();
      const brief = readTaskBrief(context, project.id, task.id, { revision: task.revision, stage: 'development' });
      measurements.push({ name, applicationReadMs: performance.now() - start, brief, measurement: measureBriefBytes(brief) });
    }
    const source = await readFile(new URL('../../../packages/application/src/task-brief.ts', import.meta.url));
    return { kind: 'pm-tools-application-measurement' as const, corpusVersion: PM_CORPUS_VERSION, corpusSemanticHash: corpusSemanticHash(), inferencePerformed: false as const,
      source: { path: 'packages/application/src/task-brief.ts', sha256: createHash('sha256').update(source).digest('hex') }, measurements,
      limitations: ['Application/Markdown boundary only; PostgreSQL membership, HTTP, OMP and external MCP were not exercised by this command.', 'No latency advantage, token usage, model comprehension or model-quality conclusion follows from these single-sample byte measurements.'] };
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await measureApplicationBaseline(); console.log(JSON.stringify({ ...report, measurements: report.measurements.map(({ brief: _brief, ...measurement }) => measurement) }, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
