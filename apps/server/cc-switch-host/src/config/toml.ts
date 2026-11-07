/**
 * Format-preserving TOML editing for the Codex and Grok Build MCP adapters.
 *
 * This is a small subset of the `toml_edit` behavior used by
 * vendor/cc-switch/src-tauri/src/mcp/codex.rs and
 * vendor/cc-switch/src-tauri/src/mcp/grokbuild.rs: locate top-level tables and
 * their child tables, replace/insert one entry without rewriting unrelated
 * text, then re-parse the result and compare it with the intended semantic
 * document. Parsing and value validation use `smol-toml`.
 */
import { parse, TomlDate } from "smol-toml";
import { mcpValidation } from "../errors.ts";

/** Marker for a shallow TOML inline table (`key = { a = "b" }`). */
export class TomlInlineTable {
  readonly entries: Record<string, unknown>;

  constructor(entries: Record<string, unknown>) {
    this.entries = entries;
  }
}

export function inlineTable(entries: Record<string, unknown>): TomlInlineTable {
  return new TomlInlineTable(entries);
}

/**
 * Generic JSON -> TOML conversion from codex.rs `json_value_to_toml_item`.
 * Null, nested arrays/objects, and empty containers are unsupported and yield
 * `undefined`; shallow objects containing only strings become inline tables.
 */
export function jsonValueToToml(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const result: unknown[] = [];
    for (const item of value) {
      if (typeof item === "string" || typeof item === "boolean") result.push(item);
      else if (typeof item === "number" && Number.isFinite(item)) result.push(item);
      else return undefined;
    }
    return result;
  }
  if (value !== null && typeof value === "object" && !(value instanceof TomlDate)) {
    const entries: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== "string") return undefined;
      entries[key] = item;
    }
    return Object.keys(entries).length === 0 ? undefined : inlineTable(entries);
  }
  return undefined;
}

interface Statement {
  kind: "header" | "value";
  /** Start of the physical line, including indentation. */
  start: number;
  /** Offset just past the statement's terminating newline. */
  end: number;
  /** Header path, or the key path written by a key/value statement. */
  path: string[];
  /** Enclosing header path for key/value statements. */
  section: string[];
  arrayHeader: boolean;
  valueStart?: number;
  valueEnd?: number;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /** True for whole-section removals, which can be replaced in place. */
  header?: boolean;
}

export class TomlDocument {
  private textValue: string;
  private parsedValue: Record<string, unknown>;
  private statements: Statement[];

  private constructor(text: string, parsed: Record<string, unknown>) {
    this.textValue = text;
    this.parsedValue = parsed;
    this.statements = scanStatements(text);
  }

  /** Parse an existing file. Invalid TOML is an error, never replaced by `{}`. */
  static parse(text: string): TomlDocument {
    return new TomlDocument(text, parseToml(text, "Invalid TOML configuration"));
  }

  static empty(): TomlDocument {
    return new TomlDocument("", {});
  }

  topLevel(key: string): unknown {
    return this.parsedValue[key];
  }

  hasTopLevel(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.parsedValue, key);
  }

  /** True when the top-level value is a TOML table (not a value or array of tables). */
  topLevelIsTable(key: string): boolean {
    return isTomlTable(this.parsedValue[key]);
  }

  /**
   * Replace the whole top-level table for `key` with `entries`.
   *
   * An existing non-table value with that key is normalized away, matching
   * codex.rs `upsert_mcp_server_table`. `entries` maps ids to table objects.
   */
  setTopLevelTable(key: string, entries: Record<string, unknown>): void {
    const lines = [`[${formatKey(key)}]`];
    const semantic: Record<string, unknown> = {};
    for (const id of Object.keys(entries).sort()) {
      const entry = entries[id];
      if (!isTomlTable(entry)) continue;
      const rendered = renderTableBlock([key, id], entry, true);
      lines.push(...rendered.lines);
      semantic[id] = rendered.semantic;
    }
    const block = `${lines.join("\n")}\n`;
    const edits = this.subtreeEdits([key]);
    const insertAt = insertionPoint(edits);
    const output = insertAt === undefined
      ? appendBlock(applyEdits(this.textValue, edits), block)
      : applyEdits(this.textValue, [{ start: insertAt, end: insertAt, text: block }, ...edits]);
    const expected = cloneToml(this.parsedValue);
    expected[key] = semantic;
    this.commit(output, expected);
  }

  /** Set or replace a single entry in an existing top-level table. */
  upsertTableEntry(key: string, id: string, entry: Record<string, unknown>): void {
    const rendered = renderTableBlock([key, id], entry, true);
    const entryBlock = `${rendered.lines.join("\n")}\n`;
    const current = this.parsedValue[key];

    if (isTomlTable(current)) {
      const inline = this.inlineTableStatement([key]);
      if (inline !== undefined) {
        const merged: Record<string, unknown> = { ...current, [id]: rendered.semantic };
        const valueText = renderInlineValue(merged);
        const output = applyEdits(this.textValue, [{
          start: inline.valueStart as number,
          end: inline.valueEnd as number,
          text: valueText,
        }]);
        const expected = cloneToml(this.parsedValue);
        (expected[key] as Record<string, unknown>)[id] = rendered.semantic;
        this.commit(output, expected);
        return;
      }

      const edits = this.subtreeEdits([key, id]);
      const replaceAt = insertionPoint(edits);
      if (replaceAt !== undefined) {
        const output = applyEdits(this.textValue, [{ start: replaceAt, end: replaceAt, text: entryBlock }, ...edits]);
        const expected = cloneToml(this.parsedValue);
        (expected[key] as Record<string, unknown>)[id] = rendered.semantic;
        this.commit(output, expected);
        return;
      }
      if (edits.length > 0) {
        // The entry only existed as dotted keys; append the table after every
        // top-level key, otherwise following root keys would fall into it.
        const output = appendBlock(applyEdits(this.textValue, edits), entryBlock);
        const expected = cloneToml(this.parsedValue);
        (expected[key] as Record<string, unknown>)[id] = rendered.semantic;
        this.commit(output, expected);
        return;
      }

      const insertAt = this.hasTableHeader([key]) ? this.tableRegionEnd([key]) : undefined;
      const block = insertAt === undefined ? `[${formatKey(key)}]\n${entryBlock}` : entryBlock;
      const output = insertAt === undefined
        ? appendBlock(this.textValue, block)
        : applyEdits(this.textValue, [{ start: insertAt, end: insertAt, text: block }]);
      const expected = cloneToml(this.parsedValue);
      (expected[key] as Record<string, unknown>)[id] = rendered.semantic;
      this.commit(output, expected);
      return;
    }

    // Missing or non-table (including `[[key]]` arrays): normalize to a table.
    const edits = this.subtreeEdits([key]);
    const insertAt = insertionPoint(edits);
    const block = `[${formatKey(key)}]\n${entryBlock}`;
    const output = insertAt === undefined
      ? appendBlock(applyEdits(this.textValue, edits), block)
      : applyEdits(this.textValue, [{ start: insertAt, end: insertAt, text: block }, ...edits]);
    const expected = cloneToml(this.parsedValue);
    expected[key] = { [id]: rendered.semantic };
    this.commit(output, expected);
  }

  /** Remove a top-level table (and every `[key.*]` child section). */
  removeTopLevel(key: string): void {
    const edits = this.subtreeEdits([key]);
    if (edits.length === 0) return;
    const expected = cloneToml(this.parsedValue);
    delete expected[key];
    this.commit(applyEdits(this.textValue, edits), expected);
  }

  /** Remove one entry from a top-level table, preserving every other section. */
  removeTableEntry(key: string, id: string): boolean {
    const table = this.parsedValue[key];
    if (!isTomlTable(table) || !Object.prototype.hasOwnProperty.call(table, id)) return false;
    const edits = this.subtreeEdits([key, id]);
    if (edits.length === 0) return false;
    const expected = cloneToml(this.parsedValue);
    delete (expected[key] as Record<string, unknown>)[id];
    this.pruneImplicitTables(expected, pathParent([key, id]));
    this.commit(applyEdits(this.textValue, edits), expected);
    return true;
  }

  /** Remove a child table from a top-level table (legacy `[mcp.servers]`). */
  removeTableKey(key: string, child: string): boolean {
    const table = this.parsedValue[key];
    if (!isTomlTable(table) || !Object.prototype.hasOwnProperty.call(table, child)) return false;
    const edits = this.subtreeEdits([key, child]);
    if (edits.length === 0) return false;
    const expected = cloneToml(this.parsedValue);
    delete (expected[key] as Record<string, unknown>)[child];
    this.pruneImplicitTables(expected, pathParent([key, child]));
    this.commit(applyEdits(this.textValue, edits), expected);
    return true;
  }

  toString(): string {
    return this.textValue;
  }

  private inlineTableStatement(path: string[]): Statement | undefined {
    for (const statement of this.statements) {
      if (statement.kind !== "value") continue;
      if (statement.valueStart === undefined || statement.valueEnd === undefined) continue;
      const fullPath = [...statement.section, ...statement.path];
      if (!samePath(fullPath, path)) continue;
      if (!this.textValue.slice(statement.valueStart, statement.valueEnd).trimStart().startsWith("{")) continue;
      return statement;
    }
    return undefined;
  }

  private hasTableHeader(path: string[]): boolean {
    return this.statements.some(
      (statement) => statement.kind === "header" && hasPrefix(statement.path, path),
    );
  }

  /** Drop implicit parent tables that became empty after removing a child. */
  private pruneImplicitTables(expected: Record<string, unknown>, start: string[]): void {
    let path = [...start];
    while (path.length > 0) {
      const value = valueAtPath(expected, path);
      if (!isTomlTable(value) || Object.keys(value).length > 0) return;
      if (this.isExplicitTable(path)) return;
      deleteRelative(expected, path);
      path = pathParent(path);
    }
  }

  private isExplicitTable(path: string[]): boolean {
    return this.statements.some((statement) => {
      if (statement.kind === "header") return samePath(statement.path, path);
      return samePath([...statement.section, ...statement.path], path);
    });
  }

  private tableRegionEnd(path: string[]): number | undefined {
    let end: number | undefined;
    for (const statement of this.statements) {
      const fullPath = [...statement.section, ...statement.path];
      if (hasPrefix(fullPath, path)) end = statement.end;
    }
    return end;
  }

  /**
   * Build edits removing the subtree rooted at `path`. An inline table that is
   * an ancestor of `path` is rewritten in place so that unrelated inline keys
   * survive (toml_edit's `InlineTable::remove`).
   */
  private subtreeEdits(path: string[]): Edit[] {
    const edits: Edit[] = [];
    for (const statement of this.statements) {
      const fullPath = statement.kind === "header"
        ? statement.path
        : [...statement.section, ...statement.path];

      if (hasPrefix(fullPath, path)) {
        edits.push({
          start: statement.start,
          end: statement.end,
          text: "",
          ...(statement.kind === "header" ? { header: true } : {}),
        });
        continue;
      }

      if (statement.kind !== "value") continue;
      if (!isStrictPrefix(fullPath, path)) continue;
      if (statement.valueStart === undefined || statement.valueEnd === undefined) continue;
      if (!this.textValue.slice(statement.valueStart, statement.valueEnd).trimStart().startsWith("{")) continue;

      const ancestor = valueAtPath(this.parsedValue, fullPath);
      if (!isTomlTable(ancestor)) continue;
      const copy = cloneToml(ancestor) as Record<string, unknown>;
      if (!deleteRelative(copy, path.slice(fullPath.length))) continue;
      edits.push({
        start: statement.valueStart,
        end: statement.valueEnd,
        text: renderInlineValue(copy),
      });
    }
    edits.sort((left, right) => left.start - right.start || left.end - right.end);
    return edits;
  }

  private commit(text: string, expected: Record<string, unknown>): void {
    const reparsed = parseToml(text, "TOML edit produced invalid configuration");
    if (!tomlEqual(reparsed, expected)) {
      throw mcpValidation("TOML edit would change unrelated configuration");
    }
    this.textValue = text;
    this.parsedValue = reparsed;
    this.statements = scanStatements(text);
  }
}

function parseToml(text: string, context: string): Record<string, unknown> {
  try {
    const parsed: unknown = parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw mcpValidation(`${context}: root is not a table`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw mcpValidation(`${context}: ${detail}`);
  }
}

function renderTableBlock(
  path: string[],
  entries: Record<string, unknown>,
  force: boolean,
): { lines: string[]; semantic: Record<string, unknown> } {
  const scalars: string[] = [];
  const children: string[] = [];
  const semantic: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(entries)) {
    if (value instanceof TomlInlineTable) {
      const rendered = renderInlineValue(value.entries);
      const inlineSemantic = semanticInlineValue(value.entries);
      if (inlineSemantic === undefined) continue;
      scalars.push(`${formatKey(key)} = ${rendered}`);
      semantic[key] = inlineSemantic;
      continue;
    }

    if (isTomlTable(value)) {
      const child = renderTableBlock([...path, key], value, false);
      if (child.lines.length === 0 && !force) continue;
      children.push(...child.lines);
      semantic[key] = child.semantic;
      continue;
    }

    const rendered = renderTomlValue(value);
    const valueSemantic = semanticTomlValue(value);
    if (rendered === undefined || valueSemantic === undefined) continue;
    scalars.push(`${formatKey(key)} = ${rendered}`);
    semantic[key] = valueSemantic;
  }

  if (!force && scalars.length === 0 && children.length === 0) {
    return { lines: [], semantic: {} };
  }
  return {
    lines: [`[${path.map(formatKey).join(".")}]`, ...scalars, ...children],
    semantic,
  };
}

function renderTomlValue(value: unknown): string | undefined {
  if (typeof value === "string") return formatString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return formatNumber(value);
  if (value instanceof TomlDate) return value.toString();
  if (value instanceof TomlInlineTable) {
    const entries = semanticInlineValue(value.entries);
    if (entries === undefined) return undefined;
    return renderInlineValue(value.entries);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const items: string[] = [];
    for (const item of value) {
      const rendered = renderScalarValue(item);
      if (rendered === undefined) return undefined;
      items.push(rendered);
    }
    return `[${items.join(", ")}]`;
  }
  return undefined;
}

function renderScalarValue(value: unknown): string | undefined {
  if (typeof value === "string") return formatString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return formatNumber(value);
  if (value instanceof TomlDate) return value.toString();
  return undefined;
}

/** Inline tables may nest; `toml_edit` keeps the original inline shape. */
function renderInlineValue(value: unknown): string {
  if (isTomlTable(value)) {
    const parts: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      const rendered = entry instanceof TomlInlineTable || isTomlTable(entry)
        ? renderInlineValue(entry instanceof TomlInlineTable ? entry.entries : entry)
        : renderScalarValue(entry);
      if (rendered === undefined) continue;
      parts.push(`${formatKey(key)} = ${rendered}`);
    }
    return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const rendered = item instanceof TomlInlineTable || isTomlTable(item)
        ? renderInlineValue(item instanceof TomlInlineTable ? item.entries : item)
        : renderScalarValue(item);
      if (rendered !== undefined) items.push(rendered);
    }
    return `[${items.join(", ")}]`;
  }
  const rendered = renderScalarValue(value);
  return rendered ?? '""';
}

function semanticTomlValue(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value instanceof TomlDate) return value;
  if (value instanceof TomlInlineTable) return semanticInlineValue(value.entries);
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const result: unknown[] = [];
    for (const item of value) {
      const semantic = semanticTomlValue(item);
      if (semantic === undefined) return undefined;
      result.push(semantic);
    }
    return result;
  }
  return undefined;
}

function semanticInlineValue(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    const semantic = semanticTomlValue(value);
    if (semantic === undefined) continue;
    result[key] = semantic;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Number.isInteger(value) && Number.isSafeInteger(value)) return String(value);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function formatString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    switch (character) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\t": out += "\\t"; break;
      case "\n": out += "\\n"; break;
      case "\f": out += "\\f"; break;
      case "\r": out += "\\r"; break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
        } else {
          out += character;
        }
    }
  }
  return `${out}"`;
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatString(key);
}

function appendBlock(text: string, block: string): string {
  if (text.length === 0) return block;
  return text.endsWith("\n") ? text + block : `${text}\n${block}`;
}

function applyEdits(
  text: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let output = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) throw mcpValidation("Overlapping TOML edits");
    output += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + text.slice(cursor);
}

function insertionPoint(edits: Edit[]): number | undefined {
  let point: number | undefined;
  for (const edit of edits) {
    if (edit.header !== true) continue;
    if (point === undefined || edit.start < point) point = edit.start;
  }
  return point;
}

function hasPrefix(path: string[], prefix: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => path[index] === segment);
}

function isStrictPrefix(path: string[], prefix: string[]): boolean {
  return path.length < prefix.length && hasPrefix(prefix, path);
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function pathParent(path: string[]): string[] {
  return path.slice(0, -1);
}

function valueAtPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function deleteRelative(root: Record<string, unknown>, path: string[]): boolean {
  if (path.length === 0) return false;
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index] as string;
    if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
  }
  const last = path[path.length - 1] as string;
  if (!isTomlTable(current) || !Object.prototype.hasOwnProperty.call(current, last)) return false;
  delete current[last];
  return true;
}

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof TomlDate)
    && !(value instanceof TomlInlineTable);
}

function cloneToml<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneToml(entry)) as T;
  if (isTomlTable(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneToml(entry);
    return result as T;
  }
  return value;
}

function tomlEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (left instanceof TomlDate || right instanceof TomlDate) {
    return left instanceof TomlDate && right instanceof TomlDate && left.toString() === right.toString();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => tomlEqual(item, right[index]));
  }
  if (isTomlTable(left) && isTomlTable(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!tomlEqual(left[key], right[key])) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Format-preserving statement scanner
// ---------------------------------------------------------------------------

function scanStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  let section: string[] = [];
  let position = 0;

  while (position < text.length) {
    const lineStart = position;
    let cursor = position;
    if (cursor === 0 && text.charCodeAt(0) === 0xfeff) cursor += 1;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;

    if (cursor >= text.length) break;
    if (text[cursor] === "\n" || text[cursor] === "\r") {
      position = lineEnd(text, cursor);
      continue;
    }
    if (text[cursor] === "#") {
      position = lineEnd(text, cursor);
      continue;
    }

    if (text[cursor] === "[") {
      const arrayHeader = text[cursor + 1] === "[";
      const openEnd = cursor + (arrayHeader ? 2 : 1);
      let close = openEnd;
      while (close < text.length) {
        const character = text[close];
        if (character === '"' || character === "'") {
          close = skipString(text, close);
          continue;
        }
        if (arrayHeader) {
          if (character === "]" && text[close + 1] === "]") break;
        } else if (character === "]") {
          break;
        }
        if (character === "\n" || character === "\r") throw mcpValidation("Unterminated TOML table header");
        close += 1;
      }
      if (close >= text.length) throw mcpValidation("Unterminated TOML table header");
      const path = parseKeyPath(text.slice(openEnd, close));
      let tail = close + (arrayHeader ? 2 : 1);
      while (tail < text.length && (text[tail] === " " || text[tail] === "\t" || text[tail] === "\r")) tail += 1;
      if (text[tail] === "#") tail = lineEnd(text, tail);
      else if (tail < text.length && text[tail] !== "\n" && text[tail] !== "\r") {
        throw mcpValidation("Unexpected characters after TOML table header");
      }
      const end = lineEnd(text, tail);
      statements.push({ kind: "header", start: lineStart, end, path, section: [], arrayHeader });
      section = path;
      position = end;
      continue;
    }

    let equals = -1;
    let scan = cursor;
    while (scan < text.length) {
      const character = text[scan];
      if (character === '"' || character === "'") {
        scan = skipString(text, scan);
        continue;
      }
      if (character === "=") {
        equals = scan;
        break;
      }
      if (character === "\n" || character === "\r") throw mcpValidation("TOML key without a value");
      scan += 1;
    }
    if (equals < 0) throw mcpValidation("TOML key without a value");

    const path = parseKeyPath(text.slice(cursor, equals));
    let valueStart = equals + 1;
    while (valueStart < text.length && (text[valueStart] === " " || text[valueStart] === "\t")) valueStart += 1;
    const scanned = scanValue(text, valueStart);
    statements.push({
      kind: "value",
      start: lineStart,
      end: scanned.end,
      path,
      section: [...section],
      arrayHeader: false,
      valueStart,
      valueEnd: scanned.valueEnd,
    });
    position = scanned.end;
  }

  return statements;
}

function scanValue(text: string, start: number): { valueEnd: number; end: number } {
  let cursor = start;
  let depth = 0;
  let lastNonSpace = start;
  while (cursor < text.length) {
    const character = text[cursor] as string;
    if (character === '"' || character === "'") {
      cursor = skipString(text, cursor);
      lastNonSpace = cursor - 1;
      continue;
    }
    if (character === "#") {
      if (depth === 0) {
        return { valueEnd: Math.max(lastNonSpace + 1, start), end: lineEnd(text, cursor) };
      }
      cursor = lineEnd(text, cursor);
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (depth === 0) {
        return { valueEnd: Math.max(lastNonSpace + 1, start), end: lineEnd(text, cursor) };
      }
      cursor = lineEnd(text, cursor);
      continue;
    }
    if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth = Math.max(0, depth - 1);
    if (character !== " " && character !== "\t") lastNonSpace = cursor;
    cursor += 1;
  }
  return { valueEnd: Math.max(lastNonSpace + 1, start), end: text.length };
}

function skipString(text: string, start: number): number {
  const quote = text[start] as string;
  const triple = text.startsWith(quote.repeat(3), start);
  if (triple) {
    let cursor = start + 3;
    while (cursor < text.length) {
      if (quote === '"' && text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text.startsWith(quote.repeat(3), cursor)) return cursor + 3;
      cursor += 1;
    }
    throw mcpValidation("Unterminated TOML string");
  }

  let cursor = start + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (quote === '"' && character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) return cursor + 1;
    if (character === "\n" || character === "\r") break;
    cursor += 1;
  }
  throw mcpValidation("Unterminated TOML string");
}

function parseKeyPath(raw: string): string[] {
  const path: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    while (cursor < raw.length && (raw[cursor] === " " || raw[cursor] === "\t" || raw[cursor] === "\r")) cursor += 1;
    if (cursor >= raw.length) break;
    const character = raw[cursor] as string;
    if (character === '"' || character === "'") {
      const end = skipString(raw, cursor);
      const inner = raw.slice(cursor + 1, end - 1);
      path.push(character === '"' ? decodeBasicString(inner) : inner);
      cursor = end;
    } else if (character === ".") {
      cursor += 1;
      continue;
    } else {
      const start = cursor;
      while (cursor < raw.length && !/[\s.]/.test(raw[cursor] as string)) cursor += 1;
      const bare = raw.slice(start, cursor);
      if (bare.length === 0) throw mcpValidation("Invalid TOML key");
      path.push(bare);
    }
    while (cursor < raw.length && (raw[cursor] === " " || raw[cursor] === "\t" || raw[cursor] === "\r")) cursor += 1;
    if (cursor < raw.length && raw[cursor] === ".") cursor += 1;
  }
  if (path.length === 0) throw mcpValidation("Invalid TOML key");
  return path;
}

function decodeBasicString(value: string): string {
  let output = "";
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor] as string;
    if (character !== "\\") {
      output += character;
      continue;
    }
    cursor += 1;
    const escape = value[cursor];
    switch (escape) {
      case "b": output += "\b"; break;
      case "t": output += "\t"; break;
      case "n": output += "\n"; break;
      case "f": output += "\f"; break;
      case "r": output += "\r"; break;
      case '"': output += '"'; break;
      case "\\": output += "\\"; break;
      case "u":
        output += String.fromCodePoint(Number.parseInt(value.slice(cursor + 1, cursor + 5), 16));
        cursor += 4;
        break;
      case "U":
        output += String.fromCodePoint(Number.parseInt(value.slice(cursor + 1, cursor + 9), 16));
        cursor += 8;
        break;
      default:
        if (escape !== undefined) output += escape;
    }
  }
  return output;
}

function lineEnd(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "\r") cursor += 1;
  if (cursor < text.length && text[cursor] === "\r" && text[cursor + 1] === "\n") return cursor + 2;
  if (cursor < text.length) return cursor + 1;
  return text.length;
}
