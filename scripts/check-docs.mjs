import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import { unified } from 'unified';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', '.git', '.ref', '.next', 'dist', '.local', '.runtime', '.omp', 'target', 'coverage']);
const historicalRootDocuments = new Set([
  'EXECUTION-PLAN.zh.md',
  'IMPLEMENTATION-CONTRACT.md',
  'SCENARIO-MATRIX.zh.md',
  'V3-AGENT-CHAT-TASKS.zh.md',
]);
const repositoryPath = file => path.relative(root, file).split(path.sep).join('/');
const internalDocument = file => {
  const relative = repositoryPath(file);
  return historicalRootDocuments.has(relative) || relative === 'docs/implementation' || relative.startsWith('docs/implementation/');
};
async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (excluded.has(entry.name) || internalDocument(target)) continue;
    if (entry.isDirectory()) result.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(target);
  }
  return result;
}

const markdownParser = unified().use(remarkParse);
const anchorCache = new Map();
async function documentAnchors(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const slugger = new GithubSlugger();
  const anchors = new Set();
  const pending = [markdownParser.parse(await readFile(file, 'utf8'))];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'heading') anchors.add(slugger.slug(toString(node, { includeHtml: false })));
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/\s(?:id|name)\s*=\s*(["'])(.*?)\1/gi)) anchors.add(match[2]);
    }
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
    }
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function documentLinks(text) {
  const links = [];
  const pending = [markdownParser.parse(text)];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') links.push(node.url);
    if (node.children) pending.push(...node.children);
  }
  return links;
}

const errors = [];
const files = await markdownFiles(root);
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const label = repositoryPath(file);
  if ((text.match(/^```/gm)?.length ?? 0) % 2) errors.push(`${label}: unbalanced fence`);
  for (const href of documentLinks(text)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) continue;
    const hash = href.indexOf('#');
    const filePart = (hash < 0 ? href : href.slice(0, hash)).split('?')[0];
    const anchor = hash < 0 ? '' : href.slice(hash + 1);
    let target;
    try {
      target = filePart ? path.resolve(path.dirname(file), decodeURIComponent(filePart)) : file;
    } catch {
      errors.push(`${label}: invalid local URL ${href}`);
      continue;
    }
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push(`${label}: link outside portable repository ${href}`);
      continue;
    }
    // Reject even when a local ignored copy exists: release archives do not contain it.
    if (internalDocument(target)) {
      errors.push(`${label}: public document depends on internal history ${href}`);
      continue;
    }
    try {
      await stat(target);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      errors.push(`${label}: missing ${href}`);
      continue;
    }
    if (anchor) {
      try {
        if (!(await documentAnchors(target)).has(decodeURIComponent(anchor))) errors.push(`${label}: unresolved anchor ${href}`);
      } catch (error) {
        errors.push(`${label}: unreadable anchor target ${href} (${error.code ?? error.name})`);
      }
    }
  }
}

const design = path.join(root, 'docs/domain-design');
const invariantText = await readFile(path.join(design, 'invariants.md'), 'utf8');
const scenarioText = await readFile(path.join(design, 'scenarios.md'), 'utf8');
const definitionPattern = /^\| ((?:[A-Z][A-Z\d]*-)*(?:INV|SC)-\d+) \|/gm;
const definitions = new Set();
for (const text of [invariantText, scenarioText]) {
  for (const match of text.matchAll(definitionPattern)) {
    if (definitions.has(match[1])) errors.push(`Duplicate domain definition ${match[1]}`);
    definitions.add(match[1]);
  }
}
for (const prefix of ['INV', 'SC']) {
  for (let number = 1; number <= 20; number++) {
    const id = `${prefix}-${String(number).padStart(2, '0')}`;
    if (!definitions.has(id)) errors.push(`Missing domain definition ${id}`);
  }
}
for (const file of files.filter(file => file.startsWith(`${design}${path.sep}`))) {
  for (const reference of (await readFile(file, 'utf8')).matchAll(/(?<![\w-])(?:[A-Z][A-Z\d]*-)*(?:INV|SC)-\d+\b/g)) {
    if (!definitions.has(reference[0])) errors.push(`${repositoryPath(file)}: unknown ${reference[0]}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} public Markdown files, local links/anchors and domain INV/SC definitions/references.`);
  console.log('Internal plans and historical evidence are not required and cannot be linked from public documents.');
}
