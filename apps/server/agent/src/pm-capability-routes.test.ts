import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { pmCapabilityRoutes } from "./pm-capability-routes.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const app = new Hono().route("/api", pmCapabilityRoutes);
const originalPmUrl = process.env.PM_API_URL;
let pm: Server;
let status: number;
let body: string;
let hits: number;
let received: { url?: string; method?: string; headers?: Record<string, string | string[] | undefined> };

beforeEach(async () => {
  status = 200;
  hits = 0;
  received = {};
  body = JSON.stringify({
    scope: { kind: "workspace", projectIds: [] },
    tools: [{ name: "pm_query", description: "Query", write: false, capabilities: ["domain.read"], allowed: true, denyReason: null }],
  });
  pm = createServer((request, response) => {
    hits += 1;
    received = { url: request.url, method: request.method, headers: request.headers };
    response.writeHead(status, { "content-type": "application/json", "x-pm-internal": "hidden" });
    response.end(body);
  });
  const listening = Promise.withResolvers<void>();
  pm.once("error", listening.reject);
  pm.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = pm.address();
  assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const closed = Promise.withResolvers<void>();
  pm.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  if (originalPmUrl === undefined) delete process.env.PM_API_URL;
  else process.env.PM_API_URL = originalPmUrl;
});

function request(path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost/api/pm-capabilities${path}`, { headers });
}

test("forwards only session credentials to the PM capability endpoint", async () => {
  const response = await request(`?workspaceId=${workspaceId}&projectId=PRJ-001`, {
    cookie: "pm_v4_session=fixture", authorization: "Bearer fixture", "x-internal-token": "must-not-forward",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scope: { kind: "workspace", projectIds: [] },
    tools: [{ name: "pm_query", description: "Query", write: false, capabilities: ["domain.read"], allowed: true, denyReason: null }],
  });
  assert.equal(received.method, "GET");
  assert.equal(received.url, `/api/v1/workspaces/${workspaceId}/agent-capabilities?projectId=PRJ-001`);
  assert.equal(received.headers?.cookie, "pm_v4_session=fixture");
  assert.equal(received.headers?.authorization, "Bearer fixture");
  assert.equal(received.headers?.["x-internal-token"], undefined);
  assert.equal(response.headers.get("x-pm-internal"), null);
});

test("omits projectId when the caller does not select a project", async () => {
  assert.equal((await request(`?workspaceId=${workspaceId}`)).status, 200);
  assert.equal(received.url, `/api/v1/workspaces/${workspaceId}/agent-capabilities`);
});

test("maps PM access denials without leaking their response or origin", async () => {
  for (const [pmStatus, expected] of [[401, 401], [403, 403], [404, 404]] as const) {
    status = pmStatus;
    body = JSON.stringify({ error: `internal-detail-${pmStatus}`, origin: process.env.PM_API_URL });
    const response = await request(`?workspaceId=${workspaceId}`);
    assert.equal(response.status, expected);
    const payload = await response.text();
    assert.ok(!payload.includes("internal-detail"));
    assert.ok(!payload.includes("127.0.0.1"));
  }
});

test("maps other PM failures and malformed capability payloads to 503", async () => {
  status = 500;
  body = JSON.stringify({ error: "pm stack trace" });
  const failed = await request(`?workspaceId=${workspaceId}`);
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("stack trace"));

  status = 200;
  body = JSON.stringify({ scope: { kind: "workspace", projectIds: [] } });
  assert.equal((await request(`?workspaceId=${workspaceId}`)).status, 503);

  status = 200;
  body = "not json";
  assert.equal((await request(`?workspaceId=${workspaceId}`)).status, 503);
});

test("validates the query before contacting PM", async () => {
  assert.equal((await request("")).status, 400);
  assert.equal((await request(`?workspaceId=not-a-uuid`)).status, 400);
  assert.equal((await request(`?workspaceId=${workspaceId}&projectId=TASK-1`)).status, 400);
  assert.equal((await request(`?workspaceId=${workspaceId}&projectId=`)).status, 400);
  assert.equal((await request(`?workspaceId=${workspaceId}&projectId=prj-1`)).status, 400);
  assert.equal(hits, 0);
});

test("refuses a PM origin with embedded credentials", async () => {
  const address = pm.address();
  assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://user:secret@127.0.0.1:${address.port}`;
  assert.equal((await request(`?workspaceId=${workspaceId}`)).status, 503);
  assert.equal(hits, 0);
});
