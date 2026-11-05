import { createRequire, isBuiltin } from "node:module";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { encode, file, relative, sha256 } from "./provenance.mjs";

function rustSourceLocation(source, text, offset) {
  const lineStart = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0;
  const line = text.slice(0, lineStart).split("\n").length;
  const column = Array.from(text.slice(lineStart, offset)).length + 1;
  return `${source}:${line}:${column}`;
}

// Rust strings are not JSON strings: ordinary literals may contain physical
// newlines/tabs, \' and \0, Unicode escapes with underscores, and continuations.
// Decode one escape at a time so a literal \\u/\\x/\\0 is never reinterpreted.
export function tokenizeRust(source, text) {
  const tokens = [];
  const simpleEscapes = { "0": "\0", t: "\t", n: "\n", r: "\r", '"': '"', "'": "'", "\\": "\\" };
  let index = 0;
  function fail(message, offset) {
    throw new Error(`${rustSourceLocation(source, text, offset)}: ${message}`);
  }
  function append(parts, value, kind, offset, literal = false) {
    if (kind === "byte" && literal && value.codePointAt(0) > 0x7f) fail("Non-ASCII character in Rust byte literal.", offset);
    if (kind === "c" && value.includes("\0")) fail("NUL is not allowed in a Rust C string.", offset);
    parts.push(value);
  }
  function quoted(start, prefixLength, kind, quote) {
    const parts = [];
    index = start + prefixLength + 1;
    while (index < text.length) {
      const offset = index;
      const character = String.fromCodePoint(text.codePointAt(index));
      index += character.length;
      if (character === quote) {
        const value = parts.join("");
        if (quote === "'" && Array.from(value).length !== 1) fail("Rust character literal must contain one character.", start);
        return value;
      }
      if (character === "\\") {
        if (index === text.length) fail("Unclosed Rust escape sequence.", offset);
        const escape = text[index++];
        if (Object.hasOwn(simpleEscapes, escape)) append(parts, simpleEscapes[escape], kind, offset);
        else if (escape === "x") {
          const digits = text.slice(index, index + 2);
          if (!/^[a-f\d]{2}$/i.test(digits)) fail("Rust hexadecimal escape requires exactly two hexadecimal digits.", offset);
          const value = Number.parseInt(digits, 16);
          if (kind === "str" && value > 0x7f) fail("Non-ASCII hexadecimal escape in Rust string literal.", offset);
          append(parts, String.fromCodePoint(value), kind, offset);
          index += 2;
        } else if (escape === "u") {
          if (kind === "byte") fail("Unicode escape is not allowed in a Rust byte literal.", offset);
          if (text[index] !== "{") fail("Rust Unicode escape requires braces.", offset);
          const closer = text.indexOf("}", index + 1);
          if (closer < 0) fail("Unclosed Rust Unicode escape.", offset);
          const digits = text.slice(index + 1, closer);
          const hex = digits.replaceAll("_", "");
          if (!/^[a-f\d][a-f\d_]*$/i.test(digits) || hex.length > 6) fail("Invalid Rust Unicode escape digits.", offset);
          const value = Number.parseInt(hex, 16);
          if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) fail("Rust Unicode escape is not a Unicode scalar value.", offset);
          append(parts, String.fromCodePoint(value), kind, offset);
          index = closer + 1;
        } else if (escape === "\n" || escape === "\r" && text[index] === "\n") {
          if (quote === "'") fail("Line continuation is not allowed in a Rust character literal.", offset);
          if (escape === "\r") index++;
          while (/[ \t\r\n]/.test(text[index] ?? "")) index++;
        } else fail("Unknown Rust string escape.", offset);
      } else if (character === "\r") {
        if (text[index] !== "\n") fail("Bare carriage return in Rust literal.", offset);
        if (quote === "'") fail("Unescaped newline in Rust character literal.", offset);
        index++;
        append(parts, "\n", kind, offset, true);
      } else {
        if (quote === "'" && (character === "\n" || character === "\t")) fail("Unescaped whitespace in Rust character literal.", offset);
        append(parts, character, kind, offset, true);
      }
    }
    fail("Unclosed Rust quoted literal.", start);
  }
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    const start = index;
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (text.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (depth && index < text.length) {
        if (text.startsWith("/*", index)) { depth++; index += 2; }
        else if (text.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
      if (depth) fail("Unclosed Rust block comment.", start);
      continue;
    }
    const raw = /^(b|c)?r(#{0,255})"/.exec(text.slice(index));
    if (raw) {
      const contentStart = index + raw[0].length;
      const end = text.indexOf('"' + raw[2], contentStart);
      if (end < 0) fail("Unclosed Rust raw string.", start);
      const content = text.slice(contentStart, end);
      const bareCarriageReturn = /\r(?!\n)/.exec(content);
      if (bareCarriageReturn) fail("Bare carriage return in Rust raw string.", contentStart + bareCarriageReturn.index);
      const kind = raw[1] === "b" ? "byte" : raw[1] === "c" ? "c" : "str";
      const invalid = kind === "byte" ? /[^\x00-\x7f]/.exec(content) : kind === "c" ? /\0/.exec(content) : null;
      if (invalid) fail(kind === "byte" ? "Non-ASCII character in Rust raw byte string." : "NUL is not allowed in a Rust raw C string.", contentStart + invalid.index);
      tokens.push({ value: content.replaceAll("\r\n", "\n"), string: true, literalKind: kind, offset: start });
      index = end + 1 + raw[2].length;
      continue;
    }
    if (text[index] === '"' || ["b", "c"].includes(text[index]) && text[index + 1] === '"') {
      const prefixLength = text[index] === '"' ? 0 : 1;
      const kind = text[index] === "b" ? "byte" : text[index] === "c" ? "c" : "str";
      tokens.push({ value: quoted(start, prefixLength, kind, '"'), string: true, literalKind: kind, offset: start });
      continue;
    }
    // A lifetime/label begins with an apostrophe too. Only a backslash escape
    // or one scalar followed by a closing quote identifies an ordinary char.
    if (text[index] === "b" && text[index + 1] === "'") {
      quoted(start, 1, "byte", "'");
      continue;
    }
    if (text[index] === "'" && index + 1 < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index + 1));
      if (next === "\\" || text[index + 1 + next.length] === "'") {
        quoted(start, 0, "str", "'");
        continue;
      }
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(index));
    if (word) { tokens.push({ value: word[0], offset: start }); index += word[0].length; }
    else tokens.push({ value: text[index++], offset: start });
  }
  return tokens;
}

// Static evidence is deliberately distinct from compiler/runtime acceptance.
// TS is parsed with the host's existing compiler, not an import-matching regexp.
export async function resourceClosure(root, policy, outputs, upstreamPaths) {
  const ts = createRequire(path.join(root, "package.json"))("typescript");
  const owned = new Set(outputs.map((entry) => entry.destination));
  if (!upstreamPaths) {
    const tree = JSON.parse((await file(root, "vendor/cc-switch/upstream-tree.json")).bytes);
    if (tree.version !== 1 || tree.upstreamCommit !== policy.upstreamCommit) throw new Error("Wrong pinned upstream resource tree.");
    upstreamPaths = tree.paths;
  }
  const pending = [...policy.productionRoots], seen = new Set(), edges = [], inputs = [];
  const dynamic = policy.dynamicResources ?? [];
  const aliases = Object.entries(policy.sourceAliases ?? {}).sort(([a], [b]) => b.length - a.length);
  const boundaryRoots = policy.independentForkRoots ?? [];
  async function exists(name) {
    try { return (await lstat(path.join(root, relative(name)))).isFile(); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  }
  function normalize(source, specifier) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
    return relative(target);
  }
  async function resolveFile(target, extensions = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json", ".css", "/index.ts", "/index.tsx", "/index.js"]) {
    for (const suffix of extensions) if (await exists(target + suffix)) return target + suffix;
    if (/\.[cm]?js$/.test(target)) for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) {
      const candidate = target.replace(/\.[cm]?js$/, suffix);
      if (await exists(candidate)) return candidate;
    }
    throw new Error(`Unresolved production resource: ${target}`);
  }
  async function edge(source, specifier, kind, options = {}) {
    if (typeof specifier !== "string") {
      const reviewed = dynamic.find((entry) => entry.source === source && entry.expression === options.expression && entry.kind === kind);
      if (!reviewed?.reason || !Array.isArray(reviewed.targets) || !reviewed.targets.length) throw new Error(`Unreviewed computed production resource: ${options.location ?? source}: ${options.expression}`);
      for (const target of reviewed.targets) await edge(source, target, kind, { absoluteRepositoryPath: true });
      return;
    }
    let target = null, disposition;
    const alias = aliases.find(([prefix]) => specifier === prefix || prefix.endsWith("/") && specifier.startsWith(prefix));
    if (!alias && /^(?:https?:|data:|#(?!\/))/.test(specifier)) disposition = "external-url-or-inline";
    else if (isBuiltin(specifier)) disposition = "node-builtin";
    else if (path.posix.isAbsolute(specifier) || /^[A-Za-z]:|^file:|^#\//.test(specifier) || specifier.split(/[\\/]/).includes(".ref")) throw new Error(`Forbidden production source path: ${source}: ${specifier}`);
    else if (alias || options.absoluteRepositoryPath || specifier.startsWith(".") || options.resource || specifier.startsWith("@/") || specifier.startsWith("@cc-switch/")) {
      const candidate = options.absoluteRepositoryPath ? relative(specifier)
        : alias ? alias[1] + specifier.slice(alias[0].length).split(/[?#]/)[0]
        : specifier.startsWith("@/") ? `vendor/cc-switch/src/${specifier.slice(2)}`
        : specifier.startsWith("@cc-switch/") ? `vendor/cc-switch/src/${specifier.slice(11)}`
        : normalize(source, specifier.split(/[?#]/)[0]);
      target = await resolveFile(candidate, options.extensions);
      disposition = boundaryRoots.some((prefix) => target === prefix || target.startsWith(prefix + "/"))
        ? "independently-inventoried-boundary" : owned.has(target) ? "fork-output" : "host-boundary";
      if (disposition !== "independently-inventoried-boundary") pending.push(target);
      else {
        const input = await file(root, target);
        if (!inputs.some((entry) => entry.path === target)) inputs.push({ path: target, sha256: sha256(input.bytes), bytes: input.bytes.length, ownership: disposition });
      }
    } else disposition = "external-package";
    edges.push({ source, kind, specifier, target, disposition });
  }
  // Rust scanner tokenizes comments, raw/escaped strings and balanced inline
  // modules. Only actual mod/include syntax becomes an edge; use paths do not
  // imply modules. Cargo's own locked metadata supplies external crate closure.
  async function rust(source, text) {
    const tokens = tokenizeRust(source, text);
    function balanced(start, open, close) {
      let depth = 0;
      for (let index = start; index < tokens.length; index++) {
        if (tokens[index].string) continue;
        if (tokens[index].value === open) depth++;
        if (tokens[index].value === close && --depth === 0) return index;
      }
      throw new Error(`${rustSourceLocation(source, text, tokens[start]?.offset ?? text.length)}: Unbalanced Rust ${open}${close} syntax.`);
    }
    function stringExpression(start, end) {
      const part = tokens.slice(start, end);
      if (part.length === 1 && part[0].string && part[0].literalKind === "str") return part[0].value;
      if (part[0]?.value === "concat" && part[1]?.value === "!" && part[2]?.value === "(") {
        let result = "";
        for (let index = 3; index < part.length - 1; index++) {
          if (part[index].value === ",") continue;
          if (part[index].string && part[index].literalKind === "str") result += part[index].value;
          else if (part[index].value === "env" && part[index + 1]?.value === "!" && part[index + 3]?.value === "CARGO_MANIFEST_DIR") {
            result += "@manifest"; index += 4;
          } else return null;
        }
        return result;
      }
      return null;
    }
    function cfgValue(parts) {
      let cursor = 0;
      function expression() {
        const name = parts[cursor++]?.value;
        if (["all", "any", "not"].includes(name) && parts[cursor++]?.value === "(") {
          const values = [];
          while (cursor < parts.length && parts[cursor].value !== ")") {
            values.push(expression());
            if (parts[cursor]?.value === ",") cursor++;
          }
          cursor++;
          if (name === "not") return values[0] === undefined ? undefined : !values[0];
          if (name === "all") return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
          return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
        }
        if (name === "feature" && parts[cursor++]?.value === "=") return (policy.rustFeatures ?? ["headless"]).includes(parts[cursor++]?.value);
        if (name === "test" || name === "debug_assertions") return false;
        // Retain all OS/CPU branches; native Cargo builds decide the target.
        if (parts[cursor]?.value === "=") cursor += 2;
        return undefined;
      }
      return expression();
    }
    async function scan(start, end, moduleDirectory, attributeDirectory = path.posix.dirname(source)) {
      let explicitPath = null;
      for (let index = start; index < end; index++) {
        const token = tokens[index];
        if (token.string) continue;
        if (token.value === "#" && tokens[index + 1]?.value === "[") {
          const closer = balanced(index + 1, "[", "]");
          const attribute = tokens.slice(index + 2, closer);
          if (attribute[0]?.value === "path" && attribute[1]?.value === "=" && attribute[2]?.string) explicitPath = attribute[2].value;
          // Exclude only definitely disabled release branches. Unknown platform
          // predicates remain conservative cross-platform closure inputs.
          if (attribute[0]?.value === "cfg" && cfgValue(attribute.slice(2, -1)) === false) {
            explicitPath = null;
            let item = closer + 1;
            while (item < end && !["{", ";"].includes(tokens[item].value)) item++;
            index = tokens[item]?.value === "{" ? balanced(item, "{", "}") : item;
          } else index = closer;
          continue;
        }
        if (token.value === "mod" && /^[A-Za-z_]\w*$/.test(tokens[index + 1]?.value ?? "")) {
          const name = tokens[index + 1].value, next = tokens[index + 2]?.value;
          if (next === ";") {
            const candidate = explicitPath ? path.posix.join(attributeDirectory, explicitPath) : path.posix.join(moduleDirectory, name);
            await edge(source, await resolveFile(relative(path.posix.normalize(candidate)), explicitPath ? [""] : [".rs", "/mod.rs"]), "rust-module", { absoluteRepositoryPath: true, extensions: [""] });
            explicitPath = null; index += 2;
          } else if (next === "{") {
            const closer = balanced(index + 2, "{", "}");
            await scan(index + 3, closer, path.posix.join(moduleDirectory, name), path.posix.join(moduleDirectory, name)); index = closer; explicitPath = null;
          }
        } else if (["include", "include_str", "include_bytes"].includes(token.value) && tokens[index + 1]?.value === "!" && tokens[index + 2]?.value === "(") {
          const closer = balanced(index + 2, "(", ")");
          let value = stringExpression(index + 3, closer);
          if (value?.startsWith("@manifest")) {
            let directory = path.posix.dirname(source);
            while (!await exists(`${directory}/Cargo.toml`)) {
              const parent = path.posix.dirname(directory);
              if (parent === directory || parent === ".") throw new Error(`Missing Rust manifest for include: ${source}`);
              directory = parent;
            }
            value = path.posix.normalize(directory + value.slice(9));
            await edge(source, value, token.value, { absoluteRepositoryPath: true, extensions: [""] });
          } else await edge(source, value, token.value, { resource: true, extensions: [""], expression: tokens.slice(index + 3, closer).map((part) => part.value).join(" "), location: rustSourceLocation(source, text, tokens[index].offset) });
          index = closer;
        }
      }
    }
    const directory = path.posix.dirname(source), base = path.posix.basename(source, ".rs");
    await scan(0, tokens.length, ["lib", "main", "mod", "build"].includes(base) ? directory : `${directory}/${base}`);
  }
  while (pending.length) {
    const source = relative(pending.shift());
    if (seen.has(source)) continue;
    seen.add(source);
    const bytes = (await file(root, source)).bytes, text = bytes.toString("utf8");
    inputs.push({ path: source, sha256: sha256(bytes), bytes: bytes.length, ownership: owned.has(source) ? "fork-output" : "host-boundary" });
    if (/\.[cm]?[jt]sx?$/.test(source)) {
      const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true), found = [];
      function add(node, literal, kind, resource = false) {
        if (literal) {
          const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          found.push({ value: ts.isStringLiteralLike(literal) ? literal.text : null, kind, resource, expression: literal.getText(ast), location: `${source}:${position.line + 1}:${position.character + 1}` });
        }
      }
      function visit(node) {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, "ts-import-export");
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, "ts-import-type");
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "ts-dynamic-import");
        else if (ts.isCallExpression(node) && ["require", "require.resolve"].includes(node.expression.getText(ast))) add(node, node.arguments[0], "ts-require");
        else if (ts.isCallExpression(node) && /^import\.meta\.(?:glob|globEager|resolve)$/.test(node.expression.getText(ast))) {
          const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          found.push({ value: null, kind: "ts-meta-resource", resource: true, expression: node.getText(ast), location: `${source}:${position.line + 1}:${position.character + 1}` });
        }
        else if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL" && node.arguments?.[1]?.getText(ast) === "import.meta.url") add(node, node.arguments[0], "ts-url-resource", true);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      for (const item of found) await edge(source, item.value, item.kind, item);
    } else if (source.endsWith(".rs")) await rust(source, text);
    else if (source.endsWith("Cargo.toml")) {
      for (const match of text.matchAll(/\bpath\s*=\s*"([^"\n]+)"/g)) {
        const candidate = normalize(source, match[1]);
        await edge(source, candidate.endsWith(".rs") ? candidate : `${candidate}/Cargo.toml`, "cargo-local-path", { absoluteRepositoryPath: true, extensions: [""] });
      }
      const build = /^build\s*=\s*"([^"\n]+)"/m.exec(text)?.[1] ?? "build.rs";
      if (await exists(normalize(source, build))) await edge(source, build, "cargo-build-script", { resource: true, extensions: [""] });
      for (const rootFile of ["src/lib.rs", "src/main.rs"]) if (await exists(normalize(source, rootFile))) await edge(source, rootFile, "cargo-crate-root", { resource: true, extensions: [""] });
      const lock = normalize(source, "Cargo.lock");
      if (source === "apps/server/cc-switch-host/Cargo.toml") await edge(source, lock, "cargo-lock", { absoluteRepositoryPath: true, extensions: [""] });
    } else if (/\.(?:css|scss)$/.test(source)) {
      for (const match of text.matchAll(/(?:@import\s+["']([^"']+)["']|url\(\s*["']?([^\s"')]+)["']?\s*\))/g)) await edge(source, match[1] ?? match[2], "css-resource", { resource: true, extensions: ["", ".css"] });
    }
  }
  const sourceReferences = [];
  for (const source of [...owned].filter((name) => (policy.sourceReferenceDocuments ?? []).some((prefix) => name.startsWith(prefix + "/")) && name.endsWith(".md")).sort()) {
    const text = (await file(root, source)).bytes.toString("utf8");
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), href.split("#")[0]));
      const upstreamPath = target.startsWith("vendor/cc-switch/") ? target.slice("vendor/cc-switch/".length) : href;
      const tracked = upstreamPaths.includes(upstreamPath) || upstreamPaths.some((name) => name.startsWith(upstreamPath.replace(/\/$/, "") + "/"));
      sourceReferences.push({ source, href, disposition: owned.has(target) ? "selected-source-snapshot" : tracked ? "pinned-upstream-file-not-local-closure" : "missing-in-pinned-upstream-tree", upstreamUrl: `https://github.com/farion1231/cc-switch/blob/${policy.upstreamCommit}/${upstreamPath}` });
    }
  }
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  edges.sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return encode({ version: 1, upstreamCommit: policy.upstreamCommit, parser: `typescript@${ts.version}; balanced Rust module/resource tokenizer`, roots: policy.productionRoots, limitations: "Release source/resource closure, not a compiler or behavioral pass. Cargo locked metadata in each binary manifest owns external crates. Definitely disabled feature/test branches are snapshot-only; unknown OS/CPU branches remain conservative. External package resources are bundled/packaged by the existing Web and Agent build closure. Source-reference upstream anchors are not claimed checked.", inputs, edges, sourceReferences, snapshotOnly: [...owned].filter((name) => name.startsWith("vendor/cc-switch/") && !seen.has(name)).sort(), hostIntegrationOutputs: [...owned].filter((name) => !name.startsWith("vendor/cc-switch/") && !seen.has(name)).sort() });
}
