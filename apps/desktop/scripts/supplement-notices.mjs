// Match the installed package identity; never synthesize a generic license.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const dir = new URL('../assets/dependency-notices/', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadNoticeSupplements() {
  const records = JSON.parse(await readFile(new URL('index.json', dir)));
  const result = new Map();
  for (const entry of records) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\//.test(entry.url) || entry.metadata !== 'https://registry.npmjs.org/' + encodeURIComponent(entry.name) + '/' + entry.version)
      throw new Error('Invalid supplemental notice identity or provenance: ' + entry.name);
    const bytes = await readFile(new URL(entry.sha256 + '.txt', dir));
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error('Supplemental notice fingerprint mismatch');
    const key = entry.name + '@' + entry.version;
    if (result.has(key)) throw new Error('Duplicate supplemental notice identity');
    result.set(key,{ source: entry.url, license:entry.license, bytes });
  }
  const upstream = JSON.parse(await readFile(new URL('../../../vendor/openhands-extensions/dependency-notices.json',import.meta.url)));
  for (const entry of upstream.notices) {
    const bytes = Buffer.from(entry.text), key = entry.name + '@' + entry.version;
    if (digest(bytes) !== entry.sha256 || result.has(key)) throw new Error('Invalid reviewed upstream notice');
    result.set(key, {source:entry.source,license:entry.license,bytes});
  }
  return result;
}
