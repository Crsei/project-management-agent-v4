import { createRequire, isBuiltin } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const require = createRequire(path.join(root, "package.json"));
const ts = require("typescript");
const inventory = JSON.parse(readFileSync(path.join(root, "vendor/t3code/sync-inventory.json"), "utf8"));
const adaptations = JSON.parse(readFileSync(path.join(root, "vendor/t3code/mcp-skills-adaptations.json"), "utf8"));
const owned = new Set([...inventory.files.map((entry) => entry.destination), ...adaptations.outputs.map((entry) => entry.destination)]);
const packages = new Map(inventory.files.filter((entry) => /\/package\.json$/.test(entry.destination) && !entry.destination.includes("/third-party/")).map((entry) => {
  const metadata = JSON.parse(readFileSync(path.join(root, entry.destination), "utf8"));
  return [metadata.name, { root: path.posix.dirname(entry.destination), exports: metadata.exports ?? {}, types: metadata.types ?? null }];
}));
function condition(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return condition(value.import) ?? condition(value.default) ?? condition(value.types);
}
function fileTarget(relative) {
  const sourceExtension = relative.endsWith(".js") ? relative.slice(0, -3) + ".ts"
    : relative.endsWith(".mjs") ? relative.slice(0, -4) + ".mts"
      : relative.endsWith(".cjs") ? relative.slice(0, -4) + ".cts" : relative;
  for (const candidate of [relative, sourceExtension, `${relative}.ts`, `${relative}.tsx`, `${relative}.mjs`, `${relative}.js`, `${relative}/index.ts`, `${relative}/index.js`]) {
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}
function resolve(source, specifier, resource) {
  if (path.posix.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.split(/[\\/]/).includes(".ref") || specifier.startsWith("file:")) return { disposition: "forbidden-source-path", target: null };
  let target;
  if (specifier.startsWith(".")) target = fileTarget(path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)));
  else {
    if (isBuiltin(specifier)) return { disposition: "node-builtin", target: null };
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    const workspace = packages.get(name);
    if (!workspace) return {
      disposition: name.startsWith("@t3tools/") || ["effect-acp", "effect-codex-app-server", "@pm/t3code-provider-server"].includes(name)
        ? "unresolved-workspace-export" : name.startsWith("@agent-workspace/") ? "pm-host-package" : "external-package",
      target: null,
    };
    const subpath = specifier.length === name.length ? "." : `.${specifier.slice(name.length)}`;
    let exported = condition(workspace.exports[subpath]);
    if (!exported) for (const [key, value] of Object.entries(workspace.exports)) {
      if (!key.includes("*")) continue;
      const [prefix, suffix] = key.split("*");
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) exported = condition(value)?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
    if (!exported) return { disposition: "unresolved-workspace-export", target: null };
    target = fileTarget(path.posix.normalize(path.posix.join(workspace.root, exported)));
  }
  if (!target) return { disposition: resource ? "runtime-selected-resource" : "unresolved-local", target: null };
  return { disposition: owned.has(target) ? "vendored-source" : target.startsWith("vendor/t3code/") ? "uninventoried-vendor" : "pm-host-boundary", target };
}
const edges = [];
for (const source of [...owned].filter((value) => /\.(?:[cm]?tsx?|jsx?)$/.test(value)).sort()) {
  const text = readFileSync(path.join(root, source), "utf8");
  const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  const requireNames = new Set(["require"]);
  function add(node, literal, kind, typeOnly = false, resource = false) {
    if (!literal) return;
    if (!ts.isStringLiteralLike(literal)) {
      if (resource || ["dynamic-import", "require", "require-resolve"].includes(kind)) edges.push({
        source, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        specifier: null, expression: literal.getText(ast), kind, usage: typeOnly ? "type-only" : "runtime",
        disposition: "runtime-selected-resource", target: null,
      });
      return;
    }
    edges.push({ source, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, specifier: literal.text, kind, usage: typeOnly ? "type-only" : "runtime", ...resolve(source, literal.text, resource) });
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && /(?:^|\.)createRequire$/.test(node.initializer.expression.getText(ast))) requireNames.add(node.name.text);
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, "import", node.importClause?.isTypeOnly === true || Boolean(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length && node.importClause.namedBindings.elements.every((entry) => entry.isTypeOnly) && !node.importClause.name));
    else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, "export", node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, "import-type", true);
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "dynamic-import");
      else if (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) add(node, node.arguments[0], "require");
      else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve" && ts.isIdentifier(node.expression.expression) && requireNames.has(node.expression.expression.text)) add(node, node.arguments[0], "require-resolve", false, true);
    } else if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL" && node.arguments?.[1]?.getText(ast) === "import.meta.url") add(node, node.arguments[0], "import-meta-resource", false, true);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
edges.sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : left.line - right.line || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
const result = JSON.stringify({ version: 1, upstreamCommit: inventory.upstreamCommit, adaptationCommits: adaptations.sources.map((entry) => entry.commit), parser: `typescript@${ts.version}`, scope: "Actual selected/patched vendor inputs and explicitly mapped MCP/Skills host adaptations. Other host-boundary targets remain PM-owned; resource selections may be runtime-computed. Absolute/file/.ref source imports are forbidden. Static provenance is not behavioral acceptance.", packages: [...packages].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, metadata]) => ({ name, ...metadata })), edges }, null, 2) + "\n";
const output = path.join(root, "vendor/t3code/sync-imports.json");
if (process.argv[2] === "--check") {
  if (readFileSync(output, "utf8") !== result) throw new Error("Actual import/export inventory drift. Review source changes and regenerate with --write.");
  const unresolved = edges.filter((edge) => ["unresolved-local", "unresolved-workspace-export", "uninventoried-vendor", "forbidden-source-path"].includes(edge.disposition));
  if (unresolved.length) throw new Error(`Unresolved import closure: ${JSON.stringify(unresolved)}`);
  console.log(JSON.stringify({ files: owned.size, imports: edges.length, packages: packages.size }));
} else if (process.argv[2] === "--write") {
  writeFileSync(output, result);
} else throw new Error("Usage: node vendor/t3code/scripts/imports.mjs --check|--write (write requires reviewing and recapturing sync-inventory hashes)");
