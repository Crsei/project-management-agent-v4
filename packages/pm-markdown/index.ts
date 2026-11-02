import { isMap, isScalar, parseDocument, stringify } from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { enhanceMarkdownTree, maskHiddenComments, wikiTarget } from './syntax.ts';
export { enhanceMarkdownTree, headingSlug, imageDimensions, maskHiddenComments, wikiTarget, type SyntaxNode } from './syntax.ts';
import { defaultConfiguration, entityKinds, entitySchemaFor, fieldRegistry, ProtocolError, validateTransition, viewConfigOf, viewSchema, workflowFor, type Diagnostic, type Entity, type FileRecord, type ProtocolConfiguration, type ViewConfig } from '../pm-schema/index.ts';
import { validateView } from '../pm-schema/query.ts';

interface MarkdownNode {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  url?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  lang?: string | null;
  checked?: boolean | null;
  children?: MarkdownNode[];
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath);
function parseBody(body: string): MarkdownNode {
  const source = maskHiddenComments(body);
  const tree = parser.parse(source) as MarkdownNode;
  enhanceMarkdownTree(tree, source);
  return tree;
}

function failure(code: string, message: string, field?: string, entityId?: string, line?: number): ProtocolError {
  return new ProtocolError([{ code, severity: 'error', path: '', message, ...(field ? { field } : {}), ...(entityId ? { entityId } : {}), ...(line ? { line } : {}) }]);
}

export function inspectFrontmatter(raw: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(raw);
  if (!opening) throw failure('YAML_SYNTAX', 'Missing YAML frontmatter: begin the file with ---');
  const delimiter = /^---[ \t]*(?:\r?\n|$)/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(raw);
  if (!closing) throw failure('YAML_SYNTAX', 'Unclosed YAML frontmatter: expected a closing --- line');
  const source = raw.slice(opening[0].length, closing.index);
  const document = parseDocument(source, { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length) throw failure('YAML_SYNTAX', `Invalid YAML frontmatter: ${document.errors.map((error) => error.message).join('; ')}`);
  if (!isMap(document.contents)) throw failure('YAML_SYNTAX', 'YAML frontmatter must be a mapping of property names to values');
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw failure('YAML_SYNTAX', 'YAML frontmatter property names must be strings');
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = document.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  } catch (error) {
    throw failure('YAML_SYNTAX', `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    opening: opening[0],
    closing: closing[0],
    document,
    metadata,
    body: raw.slice(closing.index + closing[0].length),
    bodyLineOffset: raw.slice(0, closing.index + closing[0].length).split('\n').length - 1,
    newline: opening[0].endsWith('\r\n') ? '\r\n' : '\n',
  };
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function plainText(node: MarkdownNode): string {
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if (typeof node.value === 'string') return node.type === 'html' ? '' : node.value;
  return (node.children ?? []).map(plainText).join('');
}
function titleHeading(tree: MarkdownNode): MarkdownNode | undefined {
  // The document's title must be a top-level heading, not a quoted example.
  return tree.children?.find((node) => node.type === 'heading' && node.depth === 1);
}
function describeValidation(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || 'metadata'}: ${issue.message}`).join('; ');
}

/** Identity inspection never interprets an unsupported document as the current protocol. */
/** Zero-based line index of the authoritative H1 in the full source, using the same AST as parsing. */
export function titleLineIndex(raw: string): number | undefined {
  try {
    const { body, bodyLineOffset } = inspectFrontmatter(raw);
    const heading = titleHeading(parseBody(body));
    if (!heading?.position) return undefined;
    return bodyLineOffset + heading.position.start.line - 1;
  } catch { return undefined; }
}

/** Native PM description excludes only the authoritative H1 and parser-indexed task checklist lines. */
export function descriptionOf(record: FileRecord): string {
  const { body, bodyLineOffset } = inspectFrontmatter(record.raw);
  const heading = titleLineIndex(record.raw);
  const titleIndex = heading === undefined ? 0 : heading - bodyLineOffset;
  const checklistIndexes = new Set(record.entity.checklist.map(item => item.line - 1 - bodyLineOffset));
  return body.split(/\r?\n/).filter((_, index) => index !== titleIndex && (record.entity.entity !== 'work_item' || !checklistIndexes.has(index))).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

export function inspectMarkdown(raw: string): { id?: string; schema?: string; title?: string } {
  try {
    const { metadata, body } = inspectFrontmatter(raw);
    const heading = titleHeading(parseBody(body));
    return {
      ...(typeof metadata.id === 'string' ? { id: metadata.id } : {}),
      ...(typeof metadata.schema === 'string' ? { schema: metadata.schema } : {}),
      ...(heading ? { title: plainText(heading).trim() } : {}),
    };
  } catch {
    // Syntax-invalid files can still reserve simple scalar identities without accepting their content.
    const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(raw);
    if (!opening) return {};
    const remainder = raw.slice(opening[0].length);
    const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
    const header = closing ? remainder.slice(0, closing.index) : remainder;
    const identity: { id?: string; schema?: string } = {};
    for (const key of ['id', 'schema'] as const) {
      const value = new RegExp(`^${key}:[ \\t]*[\"']?([A-Za-z0-9_./-]+)[\"']?[ \\t]*\\r?(?:#.*)?$`, 'm').exec(header)?.[1];
      if (value) identity[key] = value;
    }
    return identity;
  }
}

function validatePersistedFields(metadata: Record<string, unknown>, configuration: ProtocolConfiguration): void {
  const diagnostics: Diagnostic[] = [];
  for (const definition of fieldRegistry) {
    if (!Object.hasOwn(metadata, definition.name)) continue;
    const base = { severity: 'error' as const, path: '', field: definition.name, ...(typeof metadata.id === 'string' ? { entityId: metadata.id } : {}) };
    // Legacy YAML titles are preserved but never authoritative.
    if (definition.name === 'title') continue;
    if (definition.source !== 'yaml') {
      diagnostics.push({ ...base, code: 'DERIVED_FIELD', message: `${definition.name} is derived from Markdown or workspace state and cannot be persisted in YAML` });
    } else if (entityKinds.includes(metadata.entity as Entity['entity']) && !definition.entities.includes(metadata.entity as Entity['entity'])) {
      diagnostics.push({ ...base, code: 'FIELD_NOT_APPLICABLE', message: `${definition.name} is not applicable to ${String(metadata.entity)}` });
    }
  }
  for (const definition of configuration.custom_fields) {
    if (Object.hasOwn(metadata, definition.name) && !definition.entities.includes(metadata.entity as Entity['entity'])) {
      diagnostics.push({ code: 'FIELD_NOT_APPLICABLE', severity: 'error', path: '', field: definition.name,
        ...(typeof metadata.id === 'string' ? { entityId: metadata.id } : {}),
        message: `${definition.name} is not applicable to ${String(metadata.entity)}` });
    }
  }
  if (diagnostics.length) throw new ProtocolError(diagnostics);
}

/** Parse source without normalizing unknown metadata or interpreting future protocol versions. */
export function parseMarkdown(raw: string, configuration: ProtocolConfiguration = defaultConfiguration): Entity {
  const { metadata, body, bodyLineOffset } = inspectFrontmatter(raw);
  if (metadata.schema !== undefined && metadata.schema !== 'pm/v1')
    throw failure('UNSUPPORTED_SCHEMA_VERSION', `Unsupported schema ${String(metadata.schema)}; source is read-only`, 'schema', typeof metadata.id === 'string' ? metadata.id : undefined);
  validatePersistedFields(metadata, configuration);
  const tree = parseBody(body);
  const heading = titleHeading(tree);
  if (!heading || !plainText(heading).trim()) throw failure('TITLE_MISSING', 'Missing title: add a nonempty first-level Markdown heading (# Title)', 'title', typeof metadata.id === 'string' ? metadata.id : undefined);
  const checklist: Entity['checklist'] = [];
  const links = new Set<string>();
  const views: ViewConfig[] = [];
  walk(tree, (node) => {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      checklist.push({
        text: (node.children ?? []).filter((child) => child.type !== 'list').map(plainText).join(' ').trim(),
        checked: node.checked,
        line: bodyLineOffset + (node.position?.start.line ?? 1),
      });
    }
    if (node.type === 'link' && typeof node.data?.hProperties?.['data-entity-target'] === 'string') {
      const target = wikiTarget(node.data.hProperties['data-entity-target']).id;
      if (target) links.add(target);
    }
    if (node.type === 'workspaceEmbed') {
      const target = wikiTarget(String(node.data?.hProperties?.['data-document-embed'] ?? '')).id;
      if (target) links.add(target);
    }
    if (node.type === 'code' && node.lang === 'pm-view') {
      const config = parseDocument(node.value ?? '', { uniqueKeys: true });
      const line = bodyLineOffset + (node.position?.start.line ?? 1);
      if (config.errors.length) throw failure('YAML_SYNTAX', `Invalid pm-view at line ${line}: ${config.errors.map((error) => error.message).join('; ')}`, 'views', typeof metadata.id === 'string' ? metadata.id : undefined, line);
      let value: unknown;
      try { value = config.toJS({ maxAliasCount: 100 }); }
      catch (error) { throw failure('YAML_SYNTAX', `Invalid pm-view at line ${line}: ${String(error)}`, 'views', typeof metadata.id === 'string' ? metadata.id : undefined, line); }
      const result = viewSchema.safeParse(value);
      if (!result.success) throw failure('SCHEMA_VALIDATION', `Invalid pm-view at line ${line}: ${describeValidation(result.error)}`, 'views', typeof metadata.id === 'string' ? metadata.id : undefined, line);
      try { views.push(validateView(viewConfigOf(result.data), configuration)); }
      catch (error) {
        if (error instanceof ProtocolError) throw new ProtocolError(error.diagnostics.map((diagnostic) => ({
          ...diagnostic, line, ...(typeof metadata.id === 'string' ? { entityId: metadata.id } : {}),
        })));
        throw error;
      }
    }
  });
  const result = entitySchemaFor(configuration).safeParse({ ...metadata, title: plainText(heading).trim(), body, checklist, links: [...links], views });
  if (!result.success) throw new ProtocolError(result.error.issues.map((issue) => ({
    code: 'SCHEMA_VALIDATION', severity: 'error', path: '', field: issue.path.map(String).join('.'),
    ...(typeof metadata.id === 'string' ? { entityId: metadata.id } : {}),
    message: `Invalid PM metadata: ${issue.path.map(String).join('.') || 'metadata'}: ${issue.message}`,
  })));
  return result.data;
}

function escapedTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw failure('SCHEMA_VALIDATION', 'title must be a nonempty single line', 'title');
  return title.trim().replace(/([\\`*_{}\[\]<>()#!|~=+^%$])/g, '\\$1');
}

/** Change YAML nodes rather than serializing metadata; leave the Markdown suffix byte-for-byte intact. */
export function patchMarkdown(raw: string, changes: Record<string, unknown>, configuration: ProtocolConfiguration = defaultConfiguration): string {
  const entity = parseMarkdown(raw, configuration);
  const section = inspectFrontmatter(raw);
  let body = section.body;
  for (const [key, inputValue] of Object.entries(changes)) {
    const value = key === 'x-pm-location' && typeof inputValue === 'string' ? inputValue.trim() || null : inputValue;
    const definition = fieldRegistry.find((candidate) => candidate.name === key);
    if (['id', 'schema', 'entity'].includes(key)) throw failure('IMMUTABLE_FIELD', `Cannot change stable identity field ${key}`, key, entity.id);
    if (definition && !definition.editable) throw failure('DERIVED_FIELD', `${key} is derived from Markdown or workspace state; edit its source instead`, key, entity.id);
    if (definition && !definition.entities.includes(entity.entity)) throw failure('FIELD_NOT_APPLICABLE', `${key} is not applicable to ${entity.entity}`, key, entity.id);
    const custom = configuration.custom_fields.find((candidate) => candidate.name === key);
    if (custom && !custom.entities.includes(entity.entity)) throw failure('FIELD_NOT_APPLICABLE', `${key} is not applicable to ${entity.entity}`, key, entity.id);
    if (!definition && !Object.hasOwn(section.metadata, key) && !/^x-.+/.test(key)) throw failure('UNKNOWN_FIELD', `New extension field ${key} must begin with x-`, key, entity.id);
    if (value === undefined) throw failure('SCHEMA_VALIDATION', `${key} cannot be undefined; omit it or use null to remove an optional field`, key, entity.id);
    if (value === null && definition && !definition.nullable) throw failure('SCHEMA_VALIDATION', `${key} cannot be null`, key, entity.id);
    if (key === 'title') {
      const title = escapedTitle(value);
      const heading = titleHeading(parseBody(body))!;
      const start = heading.position?.start.offset;
      const end = heading.position?.end.offset;
      if (start === undefined || end === undefined) throw failure('TITLE_MISSING', 'Cannot locate Markdown title', 'title', entity.id);
      body = `${body.slice(0, start)}# ${title}${body.slice(end)}`;
    } else if (value === null) {
      section.document.delete(key);
    } else {
      const previous = section.document.get(key, true);
      const next = section.document.createNode(value);
      // Keep collection anchors valid for unknown fields that alias a changed property.
      if (previous && typeof previous === 'object') {
        for (const property of ['comment', 'commentBefore', 'spaceBefore', 'anchor', 'flow'] as const) {
          if (property in previous) Object.assign(next, { [property]: (previous as Record<string, unknown>)[property] });
        }
        if (isScalar(previous) && isScalar(next)) next.type = previous.type!;
      }
      section.document.set(key, next);
    }
  }
  // Avoid unnecessary YAML normalization for an empty patch or a title-only change.
  const yamlChanged = Object.keys(changes).some((key) => key !== 'title');
  const result = yamlChanged
    ? `${section.opening}${section.document.toString().replace(/\r?\n/g, section.newline)}${section.closing}${body}`
    : `${raw.slice(0, raw.length - section.body.length)}${body}`;
  const after = parseMarkdown(result, configuration);
  const diagnostics = validateTransition(entity, after, configuration);
  if (diagnostics.length) throw new ProtocolError(diagnostics);
  return result;
}

export function createMarkdown(input: Record<string, unknown> & { id: string; title: string }, configuration: ProtocolConfiguration = defaultConfiguration): string {
  for (const key of Object.keys(input)) {
    const definition = fieldRegistry.find((candidate) => candidate.name === key);
    if (definition?.source === 'derived') throw failure('DERIVED_FIELD', `${key} is derived and cannot be supplied at creation`, key, input.id);
    if (!definition && !/^x-.+/.test(key)) throw failure('UNKNOWN_FIELD', `New extension field ${key} must begin with x-`, key, input.id);
  }
  const { title, body = '', ...metadata } = input;
  if (typeof body !== 'string') throw failure('SCHEMA_VALIDATION', 'body must be Markdown text', 'body', input.id);
  if (typeof metadata['x-pm-location'] === 'string') metadata['x-pm-location'] = metadata['x-pm-location'].trim();
  if (metadata['x-pm-location'] === '' || metadata['x-pm-location'] === null) delete metadata['x-pm-location'];
  const entity = metadata.entity === undefined ? 'work_item' : metadata.entity;
  const workflow = entityKinds.includes(entity as Entity['entity']) ? workflowFor(entity as Entity['entity'], configuration) : undefined;
  const fields = {
    schema: 'pm/v1',
    ...metadata,
    entity,
    ...(workflow && metadata.status === undefined ? { status: workflow.initial } : {}),
    ...(entity === 'work_item' ? { kind: metadata.kind === undefined ? 'task' : metadata.kind } : {}),
    ...(entity === 'work_item' || entity === 'requirement' ? { priority: metadata.priority === undefined ? 'medium' : metadata.priority } : {}),
  };
  for (const definition of configuration.custom_fields) {
    if (definition.entities.includes(entity as Entity['entity']) && !Object.hasOwn(fields, definition.name) && Object.hasOwn(definition, 'default'))
      Object.assign(fields, { [definition.name]: structuredClone(definition.default) });
  }
  const raw = `---\n${stringify(fields)}---\n\n# ${escapedTitle(title)}\n${body ? `\n${body}` : ''}`;
  parseMarkdown(raw, configuration);
  return raw;
}
