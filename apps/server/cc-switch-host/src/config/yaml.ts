/**
 * Shared YAML document helpers translated from
 * vendor/cc-switch/src-tauri/src/hermes_config.rs (`read_hermes_config`,
 * `deduplicate_top_level_keys`, `find_yaml_section_range`,
 * `replace_yaml_section`, `update_mcp_servers_yaml`) and
 * vendor/cc-switch/src-tauri/src/omp_config.rs (`has_yaml_reference_tokens`),
 * at pinned cc-switch 4.0.25.
 *
 * Hermes keeps unrelated settings, comments and ordering in `config.yaml`, so
 * sections are replaced at the text level instead of reserializing the whole
 * document. DeepSeek Harness profiles are YAML sequences and are edited with
 * the same text-splicing rules; dynamic tags such as `!!js` never round-trip
 * through `yaml`, hence the token scan.
 */
import {
  isAlias,
  isMap,
  isNode,
  isSeq,
  parse,
  parseDocument,
  stringify,
  type Node,
} from "yaml";
import { readTextFile, writeTextFile } from "./atomic.ts";
import { configError } from "../errors.ts";

function yamlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse one YAML document, rejecting syntax and duplicate-key errors. */
export function parseYamlValue(text: string): unknown {
  let value: unknown;
  try {
    value = parse(text, { uniqueKeys: true });
  } catch (error) {
    throw configError(`Failed to parse YAML: ${yamlErrorMessage(error)}`);
  }
  return value;
}

/**
 * Mapping view of a parsed YAML document. A null document (empty file or only
 * comments) is the empty mapping, mirroring `serde_yaml` null handling.
 */
export function asYamlMapping(value: unknown, message = "YAML document must be a mapping"): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw configError(message);
  return value as Record<string, unknown>;
}

/** Mapping view of one YAML value; non-mappings are the empty mapping (Rust `as_mapping`). */
export function yamlMapping(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Serialize a value in block style without folding long scalars. */
export function stringifyYaml(value: unknown): string {
  try {
    return stringify(value, { lineWidth: 0, indent: 2 });
  } catch (error) {
    throw configError(`Failed to serialize YAML: ${yamlErrorMessage(error)}`);
  }
}

/** `key:` plus one indented document, as serde_yaml writes a single-key mapping. */
function serializeYamlSection(key: string, value: unknown): string {
  const document: Record<string, unknown> = {};
  document[key] = value;
  return stringifyYaml(document);
}

/**
 * A YAML top-level key line: column 0, not blank, not a comment or sequence
 * item, with `:` followed by whitespace or end of line (CRLF included).
 */
function isTopLevelKeyLine(line: string): boolean {
  if (line === "") return false;
  const first = line.charCodeAt(0);
  if (first === 0x20 || first === 0x09 || first === 0x23 || first === 0x2d) return false;
  const colon = line.indexOf(":");
  if (colon < 0) return false;
  const after = line.slice(colon + 1);
  return after === "" || after.startsWith(" ") || after.startsWith("\t") || after.startsWith("\r") || after.startsWith("\n");
}

/**
 * Remove duplicate top-level sections, keeping the last occurrence of each key.
 *
 * Pre-CRLF-fix Hermes builds appended a section instead of replacing it, and
 * PyYAML (what Hermes itself reads) resolves duplicates last-wins, so keeping
 * the last block preserves the values Hermes actually runs with.
 */
export function deduplicateTopLevelKeys(raw: string): string {
  const sections: { key: string; start: number }[] = [];
  let offset = 0;
  for (const line of raw.split("\n")) {
    if (isTopLevelKeyLine(line)) {
      const colon = line.indexOf(":");
      if (colon >= 0) sections.push({ key: line.slice(0, colon), start: offset });
    }
    offset += line.length + 1;
  }
  const remaining = new Map<string, number>();
  for (const { key } of sections) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  if ([...remaining.values()].every((count) => count <= 1)) return raw;

  let result = "";
  const headEnd = sections.length > 0 ? sections[0].start : raw.length;
  result += raw.slice(0, headEnd);
  for (let index = 0; index < sections.length; index += 1) {
    const { key, start } = sections[index];
    const end = index + 1 < sections.length ? sections[index + 1].start : raw.length;
    const count = (remaining.get(key) ?? 0) - 1;
    remaining.set(key, count);
    if (count > 0) continue;
    result += raw.slice(start, end);
  }
  return result;
}

/** Byte range of a top-level section, from its key line to the next top-level key. */
function findYamlSectionRange(raw: string, sectionKey: string): [number, number] | undefined {
  const target = `${sectionKey}:`;
  let sectionStart: number | undefined;
  let offset = 0;
  for (const line of raw.split("\n")) {
    if (sectionStart === undefined && isTopLevelKeyLine(line) && line.startsWith(target)) {
      const after = line.slice(target.length);
      if (after === "" || after.startsWith(" ") || after.startsWith("\t") || after.startsWith("\r")) {
        sectionStart = offset;
      }
    } else if (sectionStart !== undefined && isTopLevelKeyLine(line)) {
      return [sectionStart, offset];
    }
    offset += line.length + 1;
  }
  return sectionStart === undefined ? undefined : [sectionStart, raw.length];
}

function removeAllSections(raw: string, sectionKey: string): string {
  let result = "";
  let rest = raw;
  for (;;) {
    const range = findYamlSectionRange(rest, sectionKey);
    if (range === undefined) break;
    result += rest.slice(0, range[0]);
    rest = rest.slice(range[1]);
  }
  return result + rest;
}

/** Replace or append one top-level section, preserving every other byte. */
function replaceYamlSection(raw: string, sectionKey: string, value: unknown): string {
  const serialized = serializeYamlSection(sectionKey, value);
  const range = findYamlSectionRange(raw, sectionKey);
  if (range === undefined) {
    let result = raw;
    if (result !== "" && !result.endsWith("\n")) result += "\n";
    result += serialized;
    if (!result.endsWith("\n")) result += "\n";
    return result;
  }
  let result = raw.slice(0, range[0]) + serialized;
  const remainder = removeAllSections(raw.slice(range[1]), sectionKey);
  if (!serialized.endsWith("\n") && remainder !== "" && !remainder.startsWith("\n")) result += "\n";
  return result + remainder;
}

/** Read-modify-write one top-level mapping section of a YAML file. */
export function updateYamlSectionFile(
  filename: string,
  sectionKey: string,
  update: (section: Record<string, unknown>) => void,
): void {
  const raw = readTextFile(filename) ?? "";
  const document = raw.trim() === "" ? {} : parseYamlValue(deduplicateTopLevelKeys(raw));
  const section = yamlMapping(yamlMapping(document)[sectionKey]);
  update(section);
  const next = replaceYamlSection(raw, sectionKey, section);
  if (next !== raw) writeTextFile(filename, next);
}

export interface ParsedYamlSequence {
  values: unknown[];
  nodes: (Node | null)[];
}

/** Parse a YAML sequence document; null/empty documents are empty sequences. */
export function parseYamlSequence(text: string, message: string): ParsedYamlSequence {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, { uniqueKeys: true });
  } catch (error) {
    throw configError(`${message}: ${yamlErrorMessage(error)}`);
  }
  if (document.errors.length > 0) throw configError(message);
  const contents = document.contents;
  if (contents === null || contents === undefined) return { values: [], nodes: [] };
  if (!isSeq(contents)) throw configError(message);
  let values: unknown[];
  try {
    values = document.toJS() as unknown[];
  } catch (error) {
    throw configError(`${message}: ${yamlErrorMessage(error)}`);
  }
  return { values, nodes: contents.items.map((item) => (isNode(item) ? item : null)) };
}

/** Tags that `yaml` resolves into plain JSON values. */
const RESOLVED_TAGS: Record<string, true> = {
  "tag:yaml.org,2002:str": true,
  "tag:yaml.org,2002:int": true,
  "tag:yaml.org,2002:float": true,
  "tag:yaml.org,2002:bool": true,
  "tag:yaml.org,2002:null": true,
  "tag:yaml.org,2002:map": true,
  "tag:yaml.org,2002:seq": true,
  "tag:yaml.org,2002:binary": true,
  "tag:yaml.org,2002:timestamp": true,
};

/**
 * Whether a node carries a tag `yaml` cannot represent as JSON (`!!js`, custom
 * tags). Such nodes lose their meaning when rewritten, which is why the native
 * writer refuses them instead of silently changing what DSH evaluates.
 */
export function hasDynamicYamlNode(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (isAlias(node)) return false;
  if (node.tag !== undefined && RESOLVED_TAGS[node.tag] !== true) return true;
  if (isSeq(node)) return node.items.some((item) => hasDynamicYamlNode(item));
  if (isMap(node)) {
    return node.items.some((pair) => hasDynamicYamlNode(pair.key) || hasDynamicYamlNode(pair.value));
  }
  return false;
}

/**
 * Whether a YAML line has an anchor, alias, tag or merge key outside quotes and
 * comments. `&`, `*` and `!` are indicators only where a node starts, so plain
 * scalars such as `name: Search & Fetch` stay editable.
 */
export function hasYamlReferenceTokens(line: string): boolean {
  let quote: string | undefined;
  let escaped = false;
  let nodeStart = true;
  let afterSpace = true;
  let previous = "  ";
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    index += 1;
    if (escaped) { escaped = false; continue; }
    if (quote === "\"" && character === "\\") { escaped = true; continue; }
    if (quote === "'" && character === "'" && line[index] === "'") { index += 1; continue; }
    if (quote !== undefined && quote === character) {
      quote = undefined;
      nodeStart = false;
      afterSpace = false;
      continue;
    }
    if (quote !== undefined) continue;
    if (character === ":" && previous === "<<") return true;
    if (character === "#" && afterSpace) break;
    if ((character === "\"" || character === "'") && nodeStart) {
      quote = character;
    } else if ((character === "&" || character === "*" || character === "!") && nodeStart) {
      return true;
    }
    previous = previous[1] + character;
    afterSpace = character.trim() === "";
    if (character.trim() !== "") {
      const entryMarker: boolean = nodeStart
        && (character === "-" || character === "?")
        && (index >= line.length || line[index].trim() === "");
      nodeStart = entryMarker || character === ":" || character === "[" || character === "{" || character === ",";
    }
  }
  return false;
}

