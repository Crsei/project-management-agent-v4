import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dataDirectory, projectDirectory, webDistDirectory, workspaceRoot } from "./paths.ts";

const keys = [
  "AGENT_WORKSPACE_PROJECT_ROOT",
  "AGENT_WORKSPACE_DATA_DIR",
  "AGENT_WORKSPACE_WEB_DIST",
] as const;

test("configured project, data and Web paths resolve relative to the stable workspace root", (t) => {
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  process.env.AGENT_WORKSPACE_PROJECT_ROOT = "projects/example";
  process.env.AGENT_WORKSPACE_DATA_DIR = ".data/example";
  process.env.AGENT_WORKSPACE_WEB_DIST = "artifacts/web";
  assert.equal(projectDirectory(), path.join(workspaceRoot, "projects/example"));
  assert.equal(dataDirectory(), path.join(workspaceRoot, ".data/example"));
  assert.equal(webDistDirectory(), path.join(workspaceRoot, "artifacts/web"));
  const absolute = path.join(tmpdir(), "workspace-independent-path");
  for (const key of keys) process.env[key] = absolute;
  assert.equal(projectDirectory(), absolute);
  assert.equal(dataDirectory(), absolute);
  assert.equal(webDistDirectory(), absolute);
});
