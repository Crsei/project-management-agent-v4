import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { toString } from 'mdast-util-to-string';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', '.git', '.ref', '.next', 'dist', '.local', '.runtime', 'coverage']);
async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
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

const errors = [];
let optionalReferences = 0;
const files = await markdownFiles(root);
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const label = path.relative(root, file);
  if ((text.match(/^```/gm)?.length ?? 0) % 2) errors.push(`${label}: unbalanced fence`);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
    const [filePart, anchor] = href.split('#');
    const target = filePart ? path.resolve(path.dirname(file), filePart) : file;
    if (path.relative(root, target).startsWith('..')) {
      optionalReferences++;
      continue;
    }
    try {
      await stat(target);
      if (anchor) {
        if (!(await documentAnchors(target)).has(decodeURIComponent(anchor))) {
          errors.push(`${label}: unresolved anchor ${href}`);
        }
      }
    } catch {
      errors.push(`${label}: missing ${href}`);
    }
  }
}

const design = path.join(root, 'docs/domain-design');
const plan = await readFile(path.join(design, 'README.md'), 'utf8');
const expected = [
  ...Array.from({ length: 13 }, (_, i) => `B${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, i) => `X${String(i + 1).padStart(2, '0')}`),
];
const steps = [...plan.matchAll(/^\| ([BUX]\d{2}) [^|]+\|([^|]+)\|/gm)];
if (JSON.stringify(steps.map((s) => s[1])) !== JSON.stringify(expected)) {
  errors.push('Plan step IDs/order do not match the 27-step baseline');
}
for (const step of steps) {
  for (const dependency of step[2].matchAll(/\b[BUX]\d{2}\b/g)) {
    const index = expected.indexOf(dependency[0]);
    if (index < 0 || index >= expected.indexOf(step[1])) {
      errors.push(`${step[1]}: invalid dependency ${dependency[0]}`);
    }
  }
}
const invariantText = await readFile(path.join(design, 'invariants.md'), 'utf8');
const scenarioText = await readFile(path.join(design, 'scenarios.md'), 'utf8');
const definitions = new Set([
  ...invariantText.matchAll(/^\| (INV-\d+) \|/gm),
  ...scenarioText.matchAll(/^\| (SC-\d+) \|/gm),
].map((match) => match[1]));
for (const file of files.filter((f) => f.startsWith(`${design}${path.sep}`))) {
  for (const reference of (await readFile(file, 'utf8')).matchAll(/\b(?:INV|SC)-\d+\b/g)) {
    if (!definitions.has(reference[0])) errors.push(`${file}: unknown ${reference[0]}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} Markdown files, 27 plan steps and domain references.`);
  console.log(`${optionalReferences} optional links outside this repository excluded from portable checks.`);
}
