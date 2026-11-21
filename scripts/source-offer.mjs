// Only write into the newly built/staged distribution, never the tracked template.
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

async function hash(file) {
  const digest = createHash('sha256');
  for await (const block of createReadStream(file)) digest.update(block);
  return digest.digest('hex');
}
export async function writeSourceOffer({ dist, archive, commit, dirty, notices }) {
  if (!/^[a-f0-9]{40}$/.test(commit) || typeof dirty !== 'boolean') throw new Error('Invalid source identity');
  const page = join(dist, 'legal.html'), template = await readFile(page, 'utf8');
  const pattern = /<!-- build-source-offer -->[\s\S]*?<!-- end-source-offer -->/g;
  if (template.match(pattern)?.length !== 1) throw new Error('Missing or duplicate source offer marker');
  const dir = join(dist, 'corresponding-source');
  await mkdir(dir); // refuse stale or previously staged source artifacts
  await copyFile(archive, join(dir, 'source.tar.gz'));
  await copyFile(notices, join(dir, 'notices.txt'));
  const download = '<a href="/corresponding-source/source.tar.gz" download>下载本构建对应源码 / Download corresponding source</a>';
  const sha256 = await hash(join(dir, 'source.tar.gz'));
  const reference = dirty ? '包含本地修改 / Includes local changes' :
    `<a href="https://github.com/Crsei/project-management-agent-v4/tree/${commit}" rel="noreferrer">Git 提交 / Revision</a>`;
  await writeFile(page, template.replace(pattern, `<p>${download} · <a href="/corresponding-source/notices.txt">第三方声明 / Notices</a></p><p>${reference}: <code>${commit}</code><br>Archive SHA-256: <code>${sha256}</code></p>`));
}
export async function verifySourceOffer(dist, commit, archiveSha) {
  const page = await readFile(join(dist, 'legal.html'), 'utf8');
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(archiveSha) ||
      !page.includes(`<code>${commit}</code>`) || !page.includes(`<code>${archiveSha}</code>`) ||
      !page.includes('href="/corresponding-source/source.tar.gz"') || !page.includes('href="/corresponding-source/notices.txt"') ||
      !(await lstat(join(dist, 'corresponding-source/notices.txt'))).isFile() ||
      await hash(join(dist, 'corresponding-source/source.tar.gz')) !== archiveSha) throw new Error('Source offer does not identify the actual corresponding archive');
}
