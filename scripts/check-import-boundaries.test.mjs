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
  assert.equal(inspectImportBoundaries(assembly, "import source from '../../vendor/openhands-automations/interface.json' with { type: 'json' };").length, 1);
});

test("source-checkout paths and literal escapes cannot bypass module boundaries", () => {
  for (const target of ["/tmp/source.ts", "file:///tmp/source.ts", "../../../../../.ref/upstream/index.ts"]) {
    assert.match(inspectImportBoundaries(consumer, `import '${target}';`)[0], /absolute path, file URL or .ref/);
  }
  assert.equal(inspectImportBoundaries(consumer, `import { entry } from '../../../../../ven\\u0064or/t3code/apps/server/src/provider/ClaudeModelCatalog.ts';`).length, 1);
  assert.deepEqual(inspectImportBoundaries(consumer, `// import '${source}';\nconst description = ${JSON.stringify(source)};`), []);
});

test("application may depend on approved infrastructure modules only", () => {
  const importer = "packages/application/src/feature.ts";
  assert.deepEqual(inspectImportBoundaries(importer, "import { lockWorkspace } from '../../infrastructure/src/database.ts';"), []);
  const issues = inspectImportBoundaries(importer, "import { sink } from '../../infrastructure/src/new-sink.ts';");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /packages\/application\/src\/feature\.ts/);
  assert.match(issues[0], /packages\/infrastructure\/src\/new-sink\.ts/);
  assert.match(issues[0], /application->infrastructure/);
});

test("infrastructure may implement approved application modules only", () => {
  const importer = "packages/infrastructure/src/adapter.ts";
  assert.deepEqual(inspectImportBoundaries(importer, "import type { SqlExecutor } from '../../application/src/ports.ts';"), []);
  const issues = inspectImportBoundaries(importer, "import { run } from '../../application/src/new-service.ts';");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /infrastructure->application/);
});

test("contracts may reference only the application ports module", () => {
  const importer = "packages/contracts/src/dto.ts";
  assert.deepEqual(inspectImportBoundaries(importer, "import type { SqlExecutor } from '../../application/src/ports.ts';"), []);
  const issues = inspectImportBoundaries(importer, "import { kernel } from '../../application/src/kernel.ts';");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /contracts->application/);
});

test("domain may depend on pm-schema but not on application layers", () => {
  const importer = "packages/domain/src/rule.ts";
  assert.deepEqual(inspectImportBoundaries(importer, "import type { Graph } from '../../pm-schema/index.ts';"), []);
  assert.deepEqual(inspectImportBoundaries(importer, "import { z } from 'zod';"), []);
  const issues = inspectImportBoundaries(importer, "import { access } from '../../application/src/access.ts';");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /\(domain\)/);
  assert.match(issues[0], /packages\/application\/src\/access\.ts/);
});

test("pm-core and isolated packages keep their narrow dependency sets", () => {
  assert.deepEqual(inspectImportBoundaries("packages/pm-core/index.ts", "import { graph } from '../pm-schema/index.ts';"), []);
  assert.match(inspectImportBoundaries("packages/pm-core/index.ts", "import { access } from '../application/src/access.ts';")[0], /\(pm-core\)/);
  assert.match(inspectImportBoundaries("packages/agent-client-runtime/src/client.ts", "import type { Dto } from '../../contracts/src/dto.ts';")[0], /isolated-package/);
});

test("packages must not depend on applications", () => {
  const issues = inspectImportBoundaries("packages/application/src/feature.ts", "import { api } from '../../../apps/web/src/api.ts';");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /packages-no-apps/);
  assert.match(issues[0], /apps\/web\/src\/api\.ts/);
});

test("pm and worker applications must not reach into agent, web or desktop sources", () => {
  for (const [importer, target, resolved] of [
    ["apps/server/pm/src/routes.ts", "../../agent/src/index.ts", "apps/server/agent/src/index.ts"],
    ["apps/server/pm/src/routes.ts", "../../../web/src/api.ts", "apps/web/src/api.ts"],
    ["apps/server/worker/src/worker.ts", "../../../desktop/src/main.ts", "apps/desktop/src/main.ts"],
  ]) {
    const issues = inspectImportBoundaries(importer, `import '${target}';`);
    assert.equal(issues.length, 1, target);
    assert.match(issues[0], /apps-server-backend/);
    assert.ok(issues[0].includes(resolved), target);
  }
  assert.deepEqual(inspectImportBoundaries("apps/server/pm/src/routes.ts", "import { access } from '../../../packages/application/src/access.ts';"), []);
});

test("the CLI's one reviewed desktop private-state edge stays exact", () => {
  const importer = "packages/pm-cli/agent-runtime.ts";
  assert.deepEqual(inspectImportBoundaries(importer, "import { readPrivateJson } from '../../apps/desktop/src/private-state.mjs';"), []);
  assert.match(inspectImportBoundaries(importer, "import { other } from '../../apps/desktop/src/other.mjs';")[0], /packages-no-apps/);
  assert.match(inspectImportBoundaries("packages/pm-cli/other.ts", "import { readPrivateJson } from '../../apps/desktop/src/private-state.mjs';")[0], /packages-no-apps/);
});
