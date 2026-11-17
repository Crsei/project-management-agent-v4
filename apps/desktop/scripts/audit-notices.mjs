// Read-only comparison of a particular delivery's shipped SBOM and legal archive.
// Never extract an untrusted tar onto the filesystem, or conflate a match with a grant.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { list } from 'tar';

export async function auditNotices(directory) {
  const pkg = JSON.parse(await readFile(join(directory,'desktop-package.json')));
  async function bound(name) {
    const entries = pkg.materials.filter(x=>x.path===name), file = join(directory,name);
    const info = await lstat(file);
    const sha = createHash('sha256');
    if (!info.isFile() || entries.length!==1 || entries[0].bytes!==info.size) throw new Error('Missing or wrong material: ' + name);
    for await (const chunk of createReadStream(file)) sha.update(chunk);
    if (sha.digest('hex')!==entries[0].sha256) throw new Error('Material integrity failed: ' + name);
    return file;
  }
  const bom = JSON.parse(await readFile(await bound('desktop-sbom.cdx.json')));
  const archive = await bound('desktop-legal.tar.gz');
  const prefix = 'workspace/licenses/desktop-web/', key = prefix + 'index.json';
  const members = new Set(), parts = [];
  await list({file:archive, strict:true, onReadEntry(entry) {
    const name=entry.path.replace(/^\.\//,'');
    if (entry.type !== 'File' || entry.size <= 0) return;
    if (members.has(name)) throw new Error('Duplicate archive member: '+name);
    members.add(name);
    if (name===key) {
      if (entry.size > 8*1024*1024) throw new Error('Oversized legal index');
      entry.on('data',chunk=>parts.push(chunk));
    }
  }});
  const index=JSON.parse(Buffer.concat(parts)), covered=new Set(), gaps=[];
  for (const item of index.packages) {
    const identity=item.name+'@'+(item.version??'');
    const valid=item.files.length>0 && item.files.every(path=>members.has(prefix+path)||[...members].some(name=>name.startsWith(prefix+path+'/')));
    if (!item.license || !valid) gaps.push({name:item.name,version:item.version,missing:[...(!item.license?['license metadata']:[]),...(!valid?['nonempty notice in desktop-web index']:[])]});
    else covered.add(identity);
  }
  const otherSourcesNeeded=[...new Set(bom.components.filter(x=>!covered.has(x.name+'@'+(x.version??''))).map(x=>x.name+'@'+(x.version??'')))].sort();
  const required=['runtime/node-LICENSE','runtime/postgres-LICENSE','runtime/THIRD-PARTY-NOTICES.json','electron/LICENSE.electron.txt','electron/LICENSES.chromium.html','workspace/licenses/provenance/LICENSE','workspace/licenses/provenance/THIRD_PARTY_NOTICES.md'];
  return {target:pkg.target, source:pkg.source.commit, signing:pkg.signing, legalSha256:pkg.materials.find(m=>m.path==='desktop-legal.tar.gz').sha256,
    indexedPackages:index.packages.length, sbomComponents:bom.components.length, indexGapCount:gaps.length, gaps,
    missingCoreNotices:required.filter(name=>!members.has(name)),
    sbomIdentitiesNeedingOtherEvidence:otherSourcesNeeded,
    scope:'Unmatched identities require checking bundled, nested, workspace, native or vendor records; a present file is not a redistribution grant.'};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length!==3) throw new Error('Usage: audit-notices.mjs DELIVERY_DIRECTORY');
  console.log(JSON.stringify(await auditNotices(resolve(process.argv[2])),null,2));
}
