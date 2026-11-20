import assert from "node:assert/strict";
import test from "node:test";
import {
  packageManagerFromPackageJson,
  packageScriptCommand,
  readProjectScripts,
  shellQuote,
} from "./thread-project-scripts.ts";

test("reads scripts in stable order and derives the package manager", () => {
  const result = readProjectScripts(JSON.stringify({
    packageManager: "pnpm@11.9.0",
    scripts: { test: "node --test", dev: "vite", "build:web": "vite build" },
  }));
  assert.deepEqual(result, {
    status: "ready",
    manager: "pnpm",
    scripts: [
      { name: "build:web", command: "pnpm run build:web" },
      { name: "dev", command: "pnpm run dev" },
      { name: "test", command: "pnpm run test" },
    ],
  });
});

test("malformed JSON, a non-object package and a non-object scripts field are reported", () => {
  assert.deepEqual(readProjectScripts("{"), { status: "invalid", reason: "invalid_json" });
  assert.deepEqual(readProjectScripts("[]"), { status: "invalid", reason: "invalid_package" });
  assert.deepEqual(readProjectScripts('{"scripts":[]}'), { status: "invalid", reason: "invalid_package" });
});

test("a UTF-8 BOM does not turn package.json into an invalid file", () => {
  assert.deepEqual(readProjectScripts("\uFEFF{\"scripts\":{\"dev\":\"vite\"}}"), {
    status: "ready",
    manager: "npm",
    scripts: [{ name: "dev", command: "npm run dev" }],
  });
});

test("a package without scripts is an empty state, not an error", () => {
  assert.deepEqual(readProjectScripts("{}"), { status: "no_scripts", manager: "npm" });
  assert.deepEqual(readProjectScripts('{"scripts":{}}'), { status: "no_scripts", manager: "npm" });
  assert.deepEqual(readProjectScripts('{"scripts":{"a":1,"b":null}}'), { status: "no_scripts", manager: "npm" });
});

test("package manager detection falls back to npm for unknown or missing fields", () => {
  assert.equal(packageManagerFromPackageJson({ packageManager: "yarn@4.1.0" }), "yarn");
  assert.equal(packageManagerFromPackageJson({ packageManager: "bun@1.2.0" }), "bun");
  assert.equal(packageManagerFromPackageJson({ packageManager: "npm@10.0.0" }), "npm");
  assert.equal(packageManagerFromPackageJson({ packageManager: "cargo@1" }), "npm");
  assert.equal(packageManagerFromPackageJson({}), "npm");
  assert.equal(packageManagerFromPackageJson(null), "npm");
});

test("script names are shell-quoted, including injection attempts", () => {
  assert.equal(shellQuote("build:all"), "build:all");
  assert.equal(shellQuote("two words"), "'two words'");
  assert.equal(shellQuote("x'; rm -rf /"), "'x'\\''; rm -rf /'");
  assert.equal(shellQuote(""), "''");
  assert.equal(packageScriptCommand("npm", "x; rm -rf /"), "npm run 'x; rm -rf /'");
});
