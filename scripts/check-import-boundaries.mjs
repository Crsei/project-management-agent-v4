import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = "apps/server/agent/src/providers/";
const native = "vendor/t3code/apps/server/src/";
const packages = "vendor/t3code/packages/";

// Exact importer/module pairs, not directory exemptions. These files actually
// assemble upstream services, translate native configuration or exercise those
// boundaries. Public workspace package exports remain governed by their exports
// maps and TypeScript; reaching into a vendor source tree is separate permission.
const allowed = new Map([
  ["apps/server/agent/src/index.ts", [native + "cli/managedChatGptToken.ts", native + "claudeHistoryWorker.ts"]],
  [provider + "t3code/config-mapping.ts", [native + "provider/Drivers/ClaudeLaunchArgs.ts", native + "provider/ClaudeModelCatalog.ts", packages + "provider-pi/src/server/mcpInjection.ts"]],
  [provider + "t3code/native-paths.ts", [native + "provider/Drivers/CodexHomeLayout.ts", native + "provider/Drivers/ClaudeHome.ts", native + "provider/Drivers/AntigravitySkills.ts", packages + "provider-omp/src/server/launch.ts"]],
  [provider + "t3code/credentials.ts", [native + "provider/ProviderCredentialStore.ts"]],
  [provider + "t3code/host-runtime.ts", [native + "provider/DocumentText.ts"]],
  [provider + "t3code/registration.ts", [native + "provider/ProviderInstanceRegistry.ts"]],
  [provider + "t3code/management.ts", [native + "provider/providerMaintenanceCommand.ts", native + "provider/ProviderAuthService.ts", packages + "provider-opencode/src/server/liveWorkspace.ts", packages + "provider-pi/src/server/liveWorkspace.ts", packages + "provider-acp/src/server/liveWorkspace.ts", packages + "provider-acp-registry/src/server/probe.ts"]],
  [provider + "t3code/families/claude.ts", [native + "provider/Drivers/ClaudeDriver.ts", native + "orchestration-v2/Adapters/ClaudeAdapterV2.ts", native + "provider/ModelManifest.ts"]],
  [provider + "t3code/families/codex.ts", [native + "provider/Drivers/CodexDriver.ts", native + "orchestration-v2/Adapters/CodexAdapterV2.ts", native + "provider/ModelManifest.ts", native + "provider/CodexInstallation.ts", native + "provider/CodexManagedTokenBroker.ts", native + "provider/CodexManagedHome.ts"]],
  [provider + "t3code/families/codex-activity.ts", [native + "orchestration-v2/Adapters/CodexAdapterV2.ts"]],
  [provider + "t3code/families/codex-chatgpt-auth.ts", [native + "provider/CodexChatGptAuth.ts"]],
  [provider + "t3code/families/codex-persistence.ts", [native + "provider/ProviderCredentialStore.ts"]],
  [provider + "t3code/families/antigravity.ts", [native + "provider/Drivers/AntigravityDriver.ts", native + "provider/AntigravityInstallation.ts", native + "provider/Drivers/AntigravityUsage.ts", native + "provider/antigravityAuthSupport.ts", native + "provider/ModelManifest.ts"]],
  [provider + "t3code/families/cursor.ts", [packages + "provider-cursor/src/server/sessionEvidence.ts", packages + "provider-cursor/src/server/CursorSdkWorkerRunner.ts", packages + "provider-cursor/src/server/CursorUsageAccounts.ts", packages + "provider-cursor/src/server/CursorAccountReader.ts", packages + "provider-cursor/src/server/CursorHostPaths.ts"]],
  [provider + "t3code/families/muse.ts", [packages + "provider-muse/src/server/sessionEvidence.ts", packages + "provider-muse/src/server/MuseUsageHome.ts"]],
  [provider + "t3code/families/pi.ts", [packages + "provider-pi/src/server/sessionEvidence.ts", packages + "provider-pi/src/server/PiHostResources.ts"]],
  [provider + "t3code/upstream-services/agent-scope.ts", [native + "process/agentScope.ts"]],
  [provider + "t3code/upstream-services/document-text.ts", [native + "provider/DocumentText.ts"]],
  [provider + "t3code/upstream-services/reset-credit-coordinator.ts", [native + "provider/resetCreditCoordinator.ts"]],
  // Native integration tests are individually named; a new test is not an escape hatch.
  [provider + "drivers/acp-protocol.test.ts", [packages + "provider-acp/src/server/mcpOverAcpBridge.test-peer.ts"]],
  [provider + "drivers/antigravity.test.ts", [native + "provider/ModelManifest.ts", packages + "effect-acp/src/_generated/schema-v1.gen.ts"]],
  [provider + "drivers/claude-native.test.ts", [native + "orchestration-v2/Adapters/ClaudeAdapterV2.ts", native + "provider/ClaudeProvider.ts"]],
  [provider + "drivers/codex-managed.test.ts", [native + "provider/CodexChatGptAuth.ts"]],
  [provider + "drivers/pi-continuity.test.ts", [packages + "provider-pi/src/server/PiHostResources.ts", packages + "provider-pi/src/server/sessionEvidence.ts"]],
  [provider + "t3code/management.test.ts", [native + "provider/ProviderAuthService.ts"]],
  [provider + "t3code/families/codex-environment.test.ts", [native + "orchestration-v2/Adapters/CodexAdapterV2.ts", native + "provider/CodexProvider.ts"]],
  [provider + "t3code/families/codex-installation.test.ts", [native + "provider/CodexInstallation.ts", native + "provider/ModelManifest.ts"]],
  [provider + "t3code/families/native-installation-join.test.ts", [native + "provider/CodexInstallation.ts", native + "provider/AntigravityInstallation.ts", native + "provider/ModelManifest.ts"]],
  [provider + "t3code/testing/native-test-host.testkit.ts", [native + "provider/ProviderAuthService.ts", native + "provider/DocumentText.ts"]],
  [provider + "t3code/upstream-services/agent-scope.test.ts", [native + "processRunner.ts"]],
  ["apps/server/agent/src/usage/limits/core.test.ts", [native + "provider/resetCreditCoordinator.ts"]],
  ["apps/server/agent/src/usage/readers/transcript-cache.test.ts", [native + "provider/Drivers/codexUsage.ts"]],
  ["apps/server/agent/src/usage/readers/transcripts.test.ts", [native + "provider/Drivers/claudeUsage.ts", native + "provider/Drivers/codexUsage.ts"]],
]);

const normalize = value => value.split(path.sep).join("/");
const moduleKey = value => value.replace(/\.(?:[cm]?[jt]sx?)$/, "");
const exactAllowed = new Map([...allowed].map(([importer, targets]) => [importer, new Set(targets.map(moduleKey))]));

// Backend layer rules operate on repository-relative paths resolved from the
// import specifier, because almost every deep import is written as ../../... .
// Module allowlists are exact leaf-module names; a new module in either layer
// must be added to this table deliberately.
const infrastructureForApplication = new Set([
  "database", "auth", "automation-integrations", "automation-integrations-native", "system-mail", "blobs", "invitation-mail", "webhook-config", "account-recovery-mail", "document-sources", "document-source-history", "document-source-files", "instance-setup", "agent-file-areas", "automation-git", "automation-execution-client", "im-gateway-config", "satori-client", "mcp-service-auth", "webhook-transport", "project-blobs",
]);
const applicationForInfrastructure = new Set(["ports", "kernel", "local-projects", "restore-safety", "automation-integrations-definitions"]);
const applicationForContracts = new Set(["ports"]);
const applicationDependencies = new Set(["domain", "contracts", "pm-schema", "agent-contracts", "pm-core", "pm-markdown", "automation-resources"]);
const infrastructureDependencies = new Set(["domain", "contracts", "pm-schema", "agent-contracts", "pm-core"]);
const contractsDependencies = new Set(["domain", "agent-contracts", "pm-schema"]);
const pmCoreDependencies = new Set(["pm-schema", "pm-markdown"]);
const pmMarkdownDependencies = new Set(["pm-schema"]);
const isolatedPackages = new Set(["pm-schema", "agent-contracts", "agent-client-runtime"]);
// One reviewed exception while the desktop private-state helper is still shared
// with the CLI. New package-to-application edges must fail instead of widening
// this set silently.
const packageAppEdges = new Set(["packages/pm-cli/agent-runtime.ts -> apps/desktop/src/private-state.mjs"]);

const sourceRoots = [
  "apps/server/agent/src",
  "apps/server/pm/src",
  "apps/server/worker/src",
  "apps/web/src/features/agent",
  "packages/domain/src",
  "packages/application/src",
  "packages/contracts/src",
  "packages/infrastructure/src",
  "packages/pm-core",
  "packages/pm-markdown",
  "packages/pm-schema",
  "packages/ui/src",
  "packages/agent-contracts/src",
  "packages/agent-client-runtime/src",
  "packages/automation-resources",
  "packages/pm-cli",
  "packages/pm-views",
  "packages/skill-resources",
];

/** AST inspection shared by the CLI and its negative regression fixtures. */
export function inspectImportBoundaries(filename, text) {
  const relative = normalize(path.relative(repository, path.resolve(repository, filename)));
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const issues = [];
  const isContract = relative.startsWith("packages/contracts/src/");
  const report = (node, message) => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    issues.push(`${relative}:${location.line + 1}:${location.character + 1} ${message}`);
  };
  const inspect = (literal, typeOnly = false, moduleReference = true) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const specifier = literal.text;
    const target = specifier.startsWith(".")
      ? normalize(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)))
      : specifier;
    if (/(?:^|\/)\.ref(?:\/|$)/.test(target) || specifier.startsWith("file:") || path.isAbsolute(specifier)) {
      report(literal, "Source imports must not depend on an absolute path, file URL or .ref checkout.");
      return;
    }
    if (isContract && (target.startsWith("packages/automation-resources/") || target.startsWith("vendor/") || /^@(?:t3tools|pm\/t3code-provider-server)(?:\/|$)/.test(target))) {
      report(literal, "Contracts contain host DTOs/schema only; catalog/bundle assembly and vendor code belong to their adapters.");
      return;
    }
    if (moduleKey(target) === "packages/contracts/src/automation-catalog" && !typeOnly) {
      report(literal, "Import catalog DTOs with import type; runtime catalog helpers live in packages/automation-resources.");
    }
    if (target.startsWith("vendor/") && !exactAllowed.get(relative)?.has(moduleKey(target))) {
      report(literal, `Unapproved vendor source dependency: ${target}. Use the owning host interface or review an exact adapter/module pair.`);
    }
    if (moduleReference) {
      const importerPackage = /^packages\/([^/]+)\//.exec(relative)?.[1];
      const targetPackage = /^packages\/([^/]+)\//.exec(target)?.[1];
      const targetModule = /^packages\/[^/]+\/(?:src\/)?([^/]+)/.exec(target)?.[1]?.replace(/\.(?:[cm]?[jt]sx?)$/, "");
      const targetApp = target.startsWith("apps/");
      const importerApp = /^apps\/server\/(?:pm|worker)\//.test(relative);
      const isBare = !specifier.startsWith(".") && !specifier.startsWith("file:") && !path.isAbsolute(specifier);
      const boundary = (rule, message) => report(literal, `Backend layer boundary (${rule}): ${relative} must not import ${target}. ${message}`);
      const list = set => [...set].join(", ");

      if (importerPackage && targetApp) {
        if (!packageAppEdges.has(`${relative} -> ${target}`)) {
          boundary("packages-no-apps", "Packages must not depend on applications; move the shared contract into a package or invert the dependency.");
        }
      } else if (importerPackage === "domain") {
        if (isBare && !target.startsWith("node:") && specifier !== "zod") {
          boundary("domain", "Domain may only use node:*, zod and packages/pm-schema.");
        } else if (targetPackage && targetPackage !== "domain" && targetPackage !== "pm-schema") {
          boundary("domain", "Domain may only use node:*, zod and packages/pm-schema.");
        }
      } else if (importerPackage === "application") {
        if (targetPackage === "infrastructure") {
          if (!infrastructureForApplication.has(targetModule)) boundary("application->infrastructure", `Only these infrastructure modules are approved: ${list(infrastructureForApplication)}.`);
        } else if (targetPackage && targetPackage !== "application" && !applicationDependencies.has(targetPackage)) {
          boundary("application", `Application may only use its ports layer and ${list(applicationDependencies)}.`);
        }
      } else if (importerPackage === "infrastructure") {
        if (targetPackage === "application") {
          if (!applicationForInfrastructure.has(targetModule)) boundary("infrastructure->application", `Only these application modules are approved: ${list(applicationForInfrastructure)}.`);
        } else if (targetPackage && targetPackage !== "infrastructure" && !infrastructureDependencies.has(targetPackage)) {
          boundary("infrastructure", `Infrastructure may only implement ${list(infrastructureDependencies)}.`);
        }
      } else if (importerPackage === "contracts") {
        if (targetPackage === "application") {
          if (!applicationForContracts.has(targetModule)) boundary("contracts->application", `Contracts may only reference the application ports module: ${list(applicationForContracts)}.`);
        } else if (targetPackage && targetPackage !== "contracts" && !contractsDependencies.has(targetPackage)) {
          boundary("contracts", `Contracts may only use ${list(contractsDependencies)}.`);
        }
      } else if (importerPackage === "pm-core") {
        if (targetPackage && targetPackage !== "pm-core" && !pmCoreDependencies.has(targetPackage)) {
          boundary("pm-core", `pm-core may only use ${list(pmCoreDependencies)}.`);
        }
      } else if (importerPackage === "pm-markdown") {
        if (targetPackage && targetPackage !== "pm-markdown" && !pmMarkdownDependencies.has(targetPackage)) {
          boundary("pm-markdown", `pm-markdown may only use ${list(pmMarkdownDependencies)}.`);
        }
      } else if (isolatedPackages.has(importerPackage)) {
        if (targetPackage && targetPackage !== importerPackage) {
          boundary("isolated-package", `${importerPackage} must not depend on other workspace packages.`);
        }
      }

      if (importerApp && /^apps\/(?:server\/agent|web|desktop)(?:\/|$)/.test(target)) {
        boundary("apps-server-backend", "apps/server/pm and apps/server/worker must not depend on agent, web or desktop sources.");
      }
    }
  };
  const createRequireNames = new Set(["createRequire"]);
  const requireNames = new Set(["require"]);
  const collectRequireNames = node => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "node:module" && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "createRequire") createRequireNames.add(element.name.text);
      }
    }
    ts.forEachChild(node, collectRequireNames);
  };
  collectRequireNames(source);
  const collectRequireBindings = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const expression = node.initializer.expression;
      if ((ts.isIdentifier(expression) && createRequireNames.has(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) && expression.name.text === "createRequire")) requireNames.add(node.name.text);
    }
    ts.forEachChild(node, collectRequireBindings);
  };
  collectRequireBindings(source);
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly));
      inspect(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) {
      const elements = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
      inspect(node.moduleSpecifier, node.isTypeOnly || (elements?.length > 0 && elements.every(element => element.isTypeOnly)));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      inspect(node.argument.literal, true);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspect(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)))) {
      inspect(node.arguments[0]);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve" && ts.isIdentifier(node.expression.expression) && requireNames.has(node.expression.expression.text)) {
      inspect(node.arguments[0]);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.[1]?.getText(source) === "import.meta.url") {
      inspect(node.arguments[0], false, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return issues;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(path.join(repository, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "coverage", "tests"].includes(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

export async function checkImportBoundaries() {
  const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat().sort();
  const issues = [];
  for (const filename of files) issues.push(...inspectImportBoundaries(filename, await readFile(path.join(repository, filename), "utf8")));
  if (issues.length) throw new Error(`Import boundary violations:\n${issues.join("\n")}`);
  console.log(`Import boundaries: ${files.length} owned source files; exact adapter/module permissions enforced.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await checkImportBoundaries();
}
