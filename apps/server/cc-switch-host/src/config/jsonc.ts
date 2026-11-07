/**
 * Translated from vendor/cc-switch/src-tauri/src/jsonc_document.rs and the
 * OpenCode document wrapper in vendor/cc-switch/src-tauri/src/opencode_config.rs
 * at pinned cc-switch 4.0.25.
 *
 * Semantics are parsed with JSON5 (the upstream `json5` crate); text edits are
 * computed against the jsonc-parser AST so comments, member order, quoting and
 * unrelated keys survive. The edited source is re-parsed and compared against
 * the intended value before anything is written: a serialization that does not
 * round-trip is refused instead of overwriting the user's file.
 */
import JSON5 from "json5";
import { applyEdits, parseTree, type Node, type ParseError } from "jsonc-parser";
import { AppError } from "../errors.ts";
import { readTextFile, writeTextFile } from "./atomic.ts";

/** Source written when an OpenCode config file has to be created (`OpenCodeDocument::load`). */
export const JSONC_DEFAULT_SOURCE = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

type JsonPath = Array<string | number>;

interface JsoncOperation {
  path: JsonPath;
  remove: boolean;
  value?: unknown;
}

export interface JsoncFileContents {
  /** `undefined` when the file does not exist yet. */
  source: string | undefined;
  /** Parsed semantics; `undefined` when the file does not exist yet. */
  value: Record<string, unknown> | undefined;
}

export interface JsoncFileEditOptions {
  /** Allow creating the file when it does not exist (default `true`). */
  create?: boolean;
  /** Source to start from when the file does not exist. */
  initialSource?: string;
  /** Refuse the write when the file changed between read and write (default `true`). */
  detectExternalChanges?: boolean;
}

function invalidJsonc(message: string): AppError {
  return new AppError("CONFIG", message);
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable structural comparison that keeps `{a:undefined}` distinct from `{}`. */
export function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** JSON5 semantics of a JSONC document; the root must be an object. */
export function parseJsoncSource(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(source);
  } catch (error) {
    throw invalidJsonc(`Failed to parse JSONC config: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(parsed)) {
    throw invalidJsonc("JSONC config root must be a JSON object");
  }
  return parsed;
}

/** Read a JSONC file without creating it; unreadable or invalid files throw. */
export function readJsoncFile(path: string): JsoncFileContents {
  const source = readTextFile(path);
  if (source === undefined) return { source, value: undefined };
  return { source, value: parseJsoncSource(source) };
}

/**
 * Original json-five round-trip parser accepts comments and trailing commas.
 * Anything jsonc-parser cannot represent is refused rather than rewritten.
 */
function parseJsoncTree(source: string): Node {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true });
  if (!tree || errors.length > 0) {
    const offset = errors[0]?.offset ?? 0;
    throw invalidJsonc(`Failed to parse JSONC config at offset ${offset}`);
  }
  if (tree.type !== "object") {
    throw invalidJsonc("JSONC config root must be a JSON object");
  }
  return tree;
}

function detectIndentUnit(source: string): string {
  for (const line of source.split(/\r?\n/)) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match !== null) return match[1].includes("\t") ? "\t" : match[1];
  }
  return "  ";
}

/** Leading whitespace of the line containing `offset`. */
function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(offset - 1, 0)) + 1;
  let end = lineStart;
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end += 1;
  return source.slice(lineStart, end);
}

function formatValue(value: unknown, indent: string, eol: string, unit: string): string {
  const pretty = JSON.stringify(value, null, unit);
  if (pretty === undefined) return "null";
  const lines = pretty.split("\n");
  if (lines.length === 1) return pretty;
  return lines.join(eol + indent);
}

function nodeAt(tree: Node, path: JsonPath): Node | undefined {
  let node: Node | undefined = tree;
  for (const segment of path) {
    if (node === undefined) return undefined;
    if (node.type === "object" && typeof segment === "string") {
      const property: Node | undefined = (node.children ?? []).find(
        (child) => child.type === "property" && child.children?.[0]?.value === segment,
      );
      node = property?.children?.[1];
    } else if (node.type === "array" && typeof segment === "number") {
      node = node.children?.[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

function duplicatePropertyName(node: Node): string | undefined {
  if (node.type !== "object") return undefined;
  const seen = new Set<string>();
  for (const child of node.children ?? []) {
    const name = child.children?.[0]?.value;
    if (typeof name !== "string") continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}

/** Rust refuses edits that would silently pick one of two duplicate keys. */
function assertNoDuplicateKeys(tree: Node, path: JsonPath): void {
  let node: Node | undefined = tree;
  for (let index = 0; index <= path.length; index += 1) {
    if (node === undefined) break;
    const duplicate = duplicatePropertyName(node);
    if (duplicate !== undefined) {
      throw invalidJsonc(`Cannot edit duplicate JSONC key: ${duplicate}`);
    }
    if (index < path.length) node = nodeAt(node, [path[index]]);
  }
}

/** Skip whitespace and comments, returning the offset of the next significant character. */
function nextSignificantOffset(source: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const character = source[index];
    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      index += 1;
    } else if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
    } else {
      return index;
    }
  }
  return source.length;
}

function appendProperty(source: string, object: Node, key: string, value: unknown): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const unit = detectIndentUnit(source);
  const baseIndent = lineIndent(source, object.offset);
  const properties = object.children ?? [];
  const multiline = source.slice(object.offset, object.offset + object.length).includes("\n");

  if (properties.length === 0) {
    const childIndent = baseIndent + unit;
    const propertyText = `${JSON.stringify(key)}: ${formatValue(value, childIndent, eol, unit)}`;
    const content = `${eol}${childIndent}${propertyText}${eol}${baseIndent}`;
    return applyEdits(source, [{ offset: object.offset + 1, length: 0, content }]);
  }

  const last = properties[properties.length - 1];
  const insertAt = last.offset + last.length;
  const lastIndent = lineIndent(source, last.offset);
  const childIndent = multiline ? lastIndent : "";
  const propertyText = `${JSON.stringify(key)}: ${formatValue(value, childIndent, eol, unit)}`;
  const content = multiline ? `,${eol}${childIndent}${propertyText}` : `, ${propertyText}`;
  return applyEdits(source, [{ offset: insertAt, length: 0, content }]);
}

function setValueAt(source: string, tree: Node, path: JsonPath, value: unknown): string {
  assertNoDuplicateKeys(tree, path);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const unit = detectIndentUnit(source);

  const existing = nodeAt(tree, path);
  if (existing !== undefined) {
    const indent = lineIndent(source, existing.offset);
    const content = formatValue(value, indent, eol, unit);
    return applyEdits(source, [{ offset: existing.offset, length: existing.length, content }]);
  }

  let depth = path.length - 1;
  let parent: Node | undefined;
  while (depth >= 0) {
    parent = nodeAt(tree, path.slice(0, depth));
    if (parent !== undefined) break;
    depth -= 1;
  }
  if (parent === undefined) throw invalidJsonc("JSONC edit target is missing");

  const key = path[depth];
  let nested = value;
  for (let index = path.length - 1; index > depth; index -= 1) {
    const segment = path[index];
    nested = typeof segment === "number" ? [nested] : { [segment]: nested };
  }
  if (parent.type !== "object" || typeof key !== "string") {
    throw invalidJsonc("JSONC edit target is not an object property");
  }
  return appendProperty(source, parent, key, nested);
}

function removeValueAt(source: string, tree: Node, path: JsonPath): string {
  assertNoDuplicateKeys(tree, path);
  if (path.length === 0) throw invalidJsonc("JSONC edit cannot remove the document root");
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(tree, parentPath);
  const segment = path[path.length - 1];
  const node = nodeAt(tree, path);

  if (parent === undefined || node === undefined) {
    throw invalidJsonc("JSONC edit target is missing");
  }
  if (parent.type !== "object" || typeof segment !== "string") {
    throw invalidJsonc("JSONC removal target is not an object property");
  }

  const properties = parent.children ?? [];
  const index = properties.findIndex((child) => child.children?.[0]?.value === segment);
  if (index < 0) throw invalidJsonc("JSONC edit target is missing");

  if (index < properties.length - 1) {
    // Delete only the property and its own comma: comments and indentation
    // before the next property belong to the surviving neighbour.
    const following = nextSignificantOffset(source, node.offset + node.length);
    if (following < source.length && source[following] === ",") {
      return applyEdits(source, [{ offset: node.offset, length: following - node.offset + 1, content: "" }]);
    }
    const next = properties[index + 1];
    return applyEdits(source, [{ offset: node.offset, length: next.offset - node.offset, content: "" }]);
  }
  if (index > 0) {
    const previous = properties[index - 1];
    const previousEnd = previous.offset + previous.length;
    const comma = nextSignificantOffset(source, previousEnd);
    const start = comma < source.length && source[comma] === "," ? comma : previousEnd;
    return applyEdits(source, [{ offset: start, length: node.offset + node.length - start, content: "" }]);
  }
  const closing = parent.offset + parent.length - 1;
  return applyEdits(source, [{ offset: node.offset, length: closing - node.offset, content: "" }]);
}

function collectOperations(current: unknown, desired: unknown, path: JsonPath, operations: JsoncOperation[]): void {
  if (equalJson(current, desired)) return;

  if (isJsonObject(current) && isJsonObject(desired)) {
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(desired, key)) operations.push({ path: [...path, key], remove: true });
    }
    for (const key of Object.keys(desired)) {
      if (Object.hasOwn(current, key)) collectOperations(current[key], desired[key], [...path, key], operations);
      else operations.push({ path: [...path, key], remove: false, value: desired[key] });
    }
    return;
  }

  // Changed arrays are replaced as a unit: serde's element-wise merge can leave
  // stale elements behind, and a whole-value replacement always round-trips.
  operations.push({ path, remove: false, value: desired });
}

/**
 * Apply `desired` to `source` with minimal text edits. Returns the new source
 * (exactly `source` when semantics already match) after verifying that a JSON5
 * re-parse equals `desired`.
 */
export function applyJsoncSemantics(source: string, desired: Record<string, unknown>): string {
  const current = parseJsoncSource(source);
  if (equalJson(current, desired)) return source;

  const tree = parseJsoncTree(source);
  const operations: JsoncOperation[] = [];
  collectOperations(current, desired, [], operations);

  let edited = source;
  for (const operation of operations) {
    const currentTree = edited === source ? tree : parseJsoncTree(edited);
    edited = operation.remove
      ? removeValueAt(edited, currentTree, operation.path)
      : setValueAt(edited, currentTree, operation.path, operation.value);
  }

  parseJsoncTree(edited);
  const reparsed = parseJsoncSource(edited);
  if (!equalJson(reparsed, desired)) {
    throw invalidJsonc("Refusing to write JSONC config: serialized output does not match the intended state");
  }
  return edited;
}

/**
 * Read, edit and atomically write one JSONC file. `mutate` receives a mutable
 * copy of the current semantics; comments and unrelated keys are preserved.
 * Returns whether the file was written.
 */
export function editJsoncFile(
  path: string,
  mutate: (root: Record<string, unknown>) => void,
  options: JsoncFileEditOptions = {},
): boolean {
  const previous = readTextFile(path);
  const create = options.create ?? true;
  if (previous === undefined && !create) return false;

  const source = previous ?? options.initialSource ?? JSONC_DEFAULT_SOURCE;
  const current = parseJsoncSource(source);
  const desired = structuredClone(current);
  mutate(desired);

  if (!isJsonObject(desired)) {
    throw invalidJsonc("JSONC config root must be a JSON object");
  }
  if (equalJson(current, desired)) return false;

  const next = applyJsoncSemantics(source, desired);

  if (options.detectExternalChanges ?? true) {
    if (readTextFile(path) !== previous) {
      throw invalidJsonc(`Refusing to write ${path}: the file changed on disk. Please reload and try again`);
    }
  }
  if (next !== previous) writeTextFile(path, next, true);
  return true;
}
