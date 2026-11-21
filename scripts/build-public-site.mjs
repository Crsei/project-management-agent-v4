// Release builds bypass the development dist and task cache. The whole
// tracked commit, including build/install scripts, is available without GitHub.
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, lstat, mkdir, rename } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSourceOffer } from './source-offer.mjs';
import { checkRetiredAssets } from './retired-release-assets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const [site, output, ...rest] = process.argv.slice(2);
if (!['web','marketing'].includes(site) || !isAbsolute(output ?? '') || rest.length) throw new Error('Usage: node scripts/build-public-site.mjs web|marketing NEW_ABSOLUTE_OUTPUT');
const parent = await realpath(dirname(output));
if (parent === resolve(root) || parent.startsWith(resolve(root) + '/') || await lstat(output).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Use a new output directory outside the checkout');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', 'HEAD']);
function assertClean() {
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['rev-parse','HEAD']) !== commit || git(['status','--porcelain','--untracked-files=all'])) throw new Error('Release web build requires the unchanged clean checkout; commit local modifications first');
}
assertClean();
const work = await mkdtemp(join(parent,'.dovspace-site-'));
try {
  const dist = join(work,'dist'), archive = join(work,'source.tar.gz');
  const run = (args) => execFileSync('pnpm', args, { cwd: root, stdio: 'inherit', env: {...process.env,DOVSPACE_ISOLATED_CHECKS:'1'} });
  if (site === 'web') run(['--filter','@pm/web','build','--outDir',dist]);
  else run(['--filter','@agent-workspace/marketing','build','--outDir',dist]);
  assertClean();
  await checkRetiredAssets(dist);
  execFileSync('git', ['archive','--format=tar.gz','--prefix=Dovspace/','--output',archive,commit], {cwd:root});
  await writeSourceOffer({dist, archive, commit, dirty:false, notices:join(root,'THIRD_PARTY_NOTICES.md')});
  assertClean();
  // Reserve the destination (no replacing another site), then publish the generation.
  await mkdir(join(parent,basename(output)));
  await rename(dist, output);
} finally { await rm(work,{recursive:true,force:true}); }
