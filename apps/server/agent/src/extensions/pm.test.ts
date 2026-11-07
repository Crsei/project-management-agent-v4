import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { verifyAutomationServiceRequest } from "../../../../../packages/infrastructure/src/automation-execution-client.ts";
import { resolveExtensionBrowserScope } from "./pm.ts";

const actorId = "11111111-1111-4111-8111-111111111111";
const target = { workspaceId: "22222222-2222-4222-8222-222222222222", projectId: "PRJ-001" };
const originalPmUrl = process.env.PM_API_URL;
const originalSecret = process.env.PM_AUTOMATION_SERVICE_SECRET;
afterEach(() => {
  mock.restoreAll();
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
  if (originalSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET;
  else process.env.PM_AUTOMATION_SERVICE_SECRET = originalSecret;
});

test("project extension authority stays explicit and request-local after directory decoupling", async () => {
  process.env.PM_API_URL = "http://pm.invalid/ignored";
  process.env.PM_AUTOMATION_SERVICE_SECRET = "extension-test-service-secret-not-a-real-credential";
  const paths: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    if (url.pathname === "/api/v1/agent-contexts/authorize") {
      assert.deepEqual(body, target);
      assert.equal(headers.get("cookie"), "pm-session=fixture-only");
      assert.equal(headers.get("authorization"), "Bearer fixture-only");
      assert.equal(headers.get("x-untrusted"), null);
      return Response.json({ actorId, scope: target });
    }
    assert.equal(url.pathname, "/internal/extensions/authorize");
    assert.deepEqual(body, { scope: { actorId, ...target }, write: true });
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    assert.ok(verifyAutomationServiceRequest("POST", url.pathname, String(init?.body), headers));
    return Response.json({ authorized: true });
  });
  const resolved = await resolveExtensionBrowserScope(target, new Headers({
    cookie: "pm-session=fixture-only", authorization: "Bearer fixture-only", "x-untrusted": "never-forward",
  }), true);
  assert.deepEqual(resolved, { actorId, ...target });
  assert.deepEqual(paths, ["/api/v1/agent-contexts/authorize", "/internal/extensions/authorize"]);
  assert.doesNotMatch(JSON.stringify(resolved), /fixture-only|secret/);
});

test("a mismatched PM target cannot become extension context authority", async () => {
  process.env.PM_API_URL = "http://pm.invalid";
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ actorId, scope: { ...target, projectId: "PRJ-002" } });
  });
  await assert.rejects(resolveExtensionBrowserScope(target, new Headers()), { code: "pm_reference_unavailable" });
  assert.equal(calls, 1, "No private extension authorization may be issued for a mismatched target.");
});
