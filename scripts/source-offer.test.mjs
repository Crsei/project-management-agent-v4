import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { writeSourceOffer, verifySourceOffer } from './source-offer.mjs';
import { checkRetiredAssets } from './retired-release-assets.mjs';
for (const dirty of [false,true]) test('local source archive and immutable identity; dirty=' + dirty, async t => {
  const dist = await mkdtemp(join(tmpdir(),'offer-test-')); t.after(()=>rm(dist,{recursive:true,force:true}));
  await copyFile(new URL('../apps/web/public/legal.html',import.meta.url),join(dist,'legal.html'));
  const archive=join(dist,'input'), notices=join(dist,'input-notice'), commit='a'.repeat(40);
  await writeFile(archive,'archive fixture'); await writeFile(notices,'license fixture');
  const args={dist,archive,notices,commit,dirty};
  await assert.rejects(writeSourceOffer({...args,commit:'main'}));
  await writeSourceOffer(args);
  const hash=createHash('sha256').update('archive fixture').digest('hex');
  await verifySourceOffer(dist,commit,hash);
  assert.equal((await readFile(join(dist,'legal.html'),'utf8')).includes('github.com'),!dirty);
  await assert.rejects(writeSourceOffer(args));
  await writeFile(join(dist,'corresponding-source/source.tar.gz'),'tampered');
  await assert.rejects(verifySourceOffer(dist,commit,hash));
});
test('clean project/marketing assets retain no retired binary (also hashed names)',async () => {
  for (const directory of ['../apps/web/src/assets/','../apps/web/public/','../apps/marketing/public/'])
    await checkRetiredAssets(new URL(directory,import.meta.url).pathname);
});
