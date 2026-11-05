import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectImportBoundaries } from "./check-import-boundaries.mjs";

const consumer = "apps/server/agent/src/providers/catalog.ts";
const source = "../../../../../vendor/t3code/apps/server/src/provider/ClaudeModelCatalog.ts";

test("owned consumers cannot import native vendor internals through alternate syntax", () => {
  for (const text of [
    `import { entry } from ${JSON.stringify(source)};`,
    `import type { Entry } from ${JSON.stringify(source)};`,
    `export { entry } from ${JSON.stringify(source)};`,
    `export type { Entry } from ${JSON.stringify(source)};`,
    `const entry = await import(${JSON.stringify(source)});`,
    `const entry = require(${JSON.stringify(source)});`,
    `import entry = require(${JSON.stringify(source)});`,
    `type Entry = import(${JSON.stringify(source)}).Entry;`,
    `const resource = new URL(${JSON.stringify(source)}, import.meta.url);`,
    `import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); load(${JSON.stringify(source)});`,
    `import * as Module from 'node:module'; const load = Module.createRequire(import.meta.url); load.resolve(${JSON.stringify(source)});`,
  ]) {
    const issues = inspectImportBoundaries(consumer, text);
    assert.equal(issues.length, 1, text);
    assert.match(issues[0], /Unapproved vendor source dependency/);
  }
});

test("the reviewed configuration boundary permits only its exact native modules", () => {
  const adapter = "apps/server/agent/src/providers/t3code/config-mapping.ts";
  const prefix = "../../../../../../vendor/t3code/apps/server/src/provider/";
  assert.deepEqual(inspectImportBoundaries(adapter, `import { resolveClaudeModelSlug } from '${prefix}ClaudeModelCatalog.ts';`), []);
  assert.equal(inspectImportBoundaries(adapter, `import { auth } from '${prefix}CodexChatGptAuth.ts';`).length, 1);
  assert.equal(inspectImportBoundaries("apps/server/agent/src/providers/t3code/new-consumer.ts", `import { resolveClaudeModelSlug } from '${prefix}ClaudeModelCatalog.ts';`).length, 1);
});

test("contract sources cannot reintroduce vendor or catalog-resource dependencies", () => {
  const contract = "packages/contracts/src/automation-catalog.ts";
  for (const target of ["../../../vendor/openhands-automations/index.d.ts", "../../automation-resources/catalog.ts", "@t3tools/contracts"]) {
    assert.match(inspectImportBoundaries(contract, `import type { Entry } from '${target}';`)[0], /Contracts contain host DTOs/);
  }
  assert.deepEqual(inspectImportBoundaries(contract, "import type { PmAutomationTemplateId } from './automation-pm.ts';"), []);
});

test("catalog DTOs remain type-only while resource assembly owns the reviewed manifests", () => {
  const dto = "../../../../../packages/contracts/src/automation-catalog.ts";
  assert.deepEqual(inspectImportBoundaries(consumer, `import type { AutomationCatalogTemplate } from '${dto}';`), []);
  assert.deepEqual(inspectImportBoundaries(consumer, `import { type AutomationCatalogTemplate } from '${dto}';`), []);
  assert.match(inspectImportBoundaries(consumer, `import { automationCatalog } from '${dto}';`)[0], /Import catalog DTOs/);
  const assembly = "packages/automation-resources/catalog.ts";
  assert.deepEqual(inspectImportBoundaries(assembly, "import source from '../../vendor/openhands-automations/interface.json' with { type: 'json' };"), []);
  assert.equal(inspectImportBoundaries(assembly, "import source from '../../vendor/openhands-automations/catalog/new-template/manifest.json' with { type: 'json' };").length, 1);
});

test("source-checkout paths and literal escapes cannot bypass module boundaries", () => {
  for (const target of ["/tmp/source.ts", "file:///tmp/source.ts", "../../../../../.ref/upstream/index.ts"]) {
    assert.match(inspectImportBoundaries(consumer, `import '${target}';`)[0], /absolute path, file URL or .ref/);
  }
  assert.equal(inspectImportBoundaries(consumer, `import { entry } from '../../../../../ven\\u0064or/t3code/apps/server/src/provider/ClaudeModelCatalog.ts';`).length, 1);
  assert.deepEqual(inspectImportBoundaries(consumer, `// import '${source}';\nconst description = ${JSON.stringify(source)};`), []);
});
