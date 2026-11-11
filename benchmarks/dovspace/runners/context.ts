import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Arm, BenchEvent, FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { readRootedFile, writeRootedFile } from '../isolation/filesystem.ts';
import { makeEvent } from './telemetry.ts';

type Passage = { path: string; contentHash: string; heading: string; ordinal: number; text: string };
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

async function persist(fixture: FixtureHandle, runId: string, relative: string, content: string): Promise<BenchEvent> {
  await writeRootedFile(fixture.publicRoot, relative, content, { createParents: true });
  return makeEvent(runId, 'runner', 'generated_artifact', { path: relative, sha256: sha256(content), bytes: Buffer.byteLength(content), provenance: 'source-derived-no-gold' });
}

/** Builds the same deterministic complete source index for knowledge/full, never selects answer facts. */
export async function materializeKnowledge(fixture: FixtureHandle, runId: string, arm: Arm): Promise<BenchEvent[]> {
  if (arm === 'raw') return [];
  const docsRoot = path.join(fixture.publicRoot, 'docs');
  const rootInfo = await lstat(docsRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Knowledge source root is redirected.');
  const passages: Passage[] = [];
  const sources: { path: string; sha256: string }[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Knowledge source identity is unsafe.');
      if (stat.isDirectory()) { await visit(absolute); continue; }
      if (!entry.name.endsWith('.md') || stat.size > 1024 * 1024) continue;
      const relative = path.relative(fixture.publicRoot, absolute).split(path.sep).join('/');
      const source = await readRootedFile(fixture.publicRoot, relative, 1024 * 1024);
      const contentHash = sha256(source);
      sources.push({ path: relative, sha256: contentHash });
      let heading = '', ordinal = 0;
      for (const paragraph of source.split(/\n\s*\n/)) {
        const title = paragraph.match(/^#{1,6}\s+(.+)$/m)?.[1];
        if (title) heading = title;
        for (let offset = 0; offset < paragraph.length; offset += 1600) passages.push({ path: relative, contentHash, heading, ordinal: ordinal++, text: paragraph.slice(offset, offset + 1600) });
      }
    }
  }
  await visit(docsRoot);
  const index = JSON.stringify({ version: 1, derivation: 'All original Markdown passages; source ordering is not an authority judgment.', sources, passages }, null, 2) + '\n';
  const script = `import fs from 'node:fs';const index=JSON.parse(fs.readFileSync(new URL('./knowledge-index.json',import.meta.url),'utf8'));const terms=[...new Set(process.argv.slice(2).join(' ').toLowerCase().match(/[\\p{L}\\p{N}_-]+/gu)||[])];const ranked=index.passages.map(p=>({...p,score:terms.reduce((n,t)=>n+(p.text.toLowerCase().includes(t)?1:0)+(p.heading.toLowerCase().includes(t)?1:0),0)})).filter(p=>p.score>0).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)||a.ordinal-b.ordinal).slice(0,20);process.stdout.write(JSON.stringify({query:process.argv.slice(2).join(' '),results:ranked},null,2)+'\\n');\n`;
  return [await persist(fixture, runId, '.dovspace/knowledge-index.json', index), await persist(fixture, runId, '.dovspace/search.mjs', script)];
}

/** Full-arm portable state is exclusively this run's prior outputs and its authorized receipts. */
export async function materializeResumeContext(fixture: FixtureHandle, runId: string, arm: Arm, priorSessionId: string, checkpoint: Record<string, unknown>, after: FixtureSnapshot): Promise<BenchEvent[]> {
  if (arm !== 'dovspace') return [];
  const artifacts: Record<string, unknown> = {};
  for (const name of ['handoff.json', 'plan.json', 'requirements.json', 'research.json', 'decision.json']) {
    let content: string;
    try { content = await readRootedFile(fixture.publicRoot, `artifacts/${name}`, 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    artifacts[`artifacts/${name}`] = { contentHash: sha256(content), content: JSON.parse(content) };
  }
  const operationId = typeof checkpoint.operationId === 'string' ? checkpoint.operationId : '';
  const receipts = after.receipts.filter(receipt => receipt.operationId === operationId);
  const context = JSON.stringify({ version: 1, priorSessionId, provenance: 'This run only; no chat/native continuation and no hidden grader content.', checkpoint, artifacts, originalReceipts: receipts, instruction: 'These are prior observations, not current decision authority. Re-read current sources and reconcile the same operation identity before any write.' }, null, 2) + '\n';
  return [await persist(fixture, runId, '.dovspace/resume-context.json', context)];
}
