import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import type { PmReferenceInput, PmReferenceResolution } from "@agent-workspace/contracts/pm-references";
import { assertResolvedReferences, authorizePmTarget, pmContextPromptLine, resolvePmReferenceOperations, resolvePmReferences } from "./pm-context.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const credentials = new Headers({ cookie: "pm_v4_session=fixture", authorization: "Bearer fixture", "x-untrusted": "never-forward" });
const previousUrl = process.env.PM_API_URL;
let server: Server;
let status: number;
let mismatch: boolean;
let calls: { path: string; headers: Record<string, unknown>; body: unknown }[];
let availability: PmReferenceResolution["availability"];

beforeEach(async () => {
  status = 200; mismatch = false; calls = []; availability = "available";
  server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text) as { references?: PmReferenceInput[]; workspaceId?: string; projectId?: string | null };
    calls.push({ path: request.url!, headers: { cookie: request.headers.cookie, authorization: request.headers.authorization, untrusted: request.headers["x-untrusted"] }, body });
    response.setHeader("content-type", "application/json");
    if (status !== 200) { response.writeHead(status).end(JSON.stringify({ error: "denied" })); return; }
    if (request.url === "/api/v1/agent-contexts/authorize") {
      response.end(JSON.stringify({ actorId, scope: { workspaceId: mismatch ? otherWorkspaceId : body.workspaceId, projectId: body.projectId }, workspaceName: "PM", projectName: body.projectId }));
      return;
    }
    response.end(JSON.stringify({ items: body.references!.map(reference => ({
      ...reference, workspaceId: mismatch ? otherWorkspaceId : reference.workspaceId,
      title: `Issue ${reference.workspaceId}/${reference.projectId}/${reference.id}`,
      revision: "current-revision", availability, reason: availability === "available" ? null : "Changed in PM",
    })) }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  process.env.PM_API_URL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
  if (previousUrl === undefined) delete process.env.PM_API_URL; else process.env.PM_API_URL = previousUrl;
});

const reference: PmReferenceInput = { workspaceId, projectId: "PRJ-001", kind: "issue", id: "TASK-001", revision: null };

test("explicit references resolve identical IDs across workspaces/projects without Session ownership", async () => {
  const inputs = [reference, { ...reference, workspaceId: otherWorkspaceId }, { ...reference, projectId: "PRJ-002" }];
  const resolved = await resolvePmReferences(inputs, credentials);
  assert.deepEqual(resolved.map(item => [item.workspaceId, item.projectId, item.id]), inputs.map(item => [item.workspaceId, item.projectId, item.id]));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.path, `/api/v1/workspaces/${workspaceId}/agent-references/resolve`);
  assert.equal(calls[1]!.path, `/api/v1/workspaces/${otherWorkspaceId}/agent-references/resolve`);
  for (const call of calls) assert.deepEqual(call.headers, { cookie: "pm_v4_session=fixture", authorization: "Bearer fixture", untrusted: undefined });
  assert.doesNotMatch(JSON.stringify(resolved), /pm_v4_session|Bearer|authorization|cookie/);
});

test("PM operation evidence uses exact live target and authoritative actor", async () => {
  const result = await resolvePmReferenceOperations([reference, { ...reference, id: "TASK-002" }], credentials);
  assert.equal(result.references.length, 2);
  assert.deepEqual(result.operations, [{ actorId, target: { workspaceId, projectId: "PRJ-001" } }]);
  assert.equal(calls.filter(call => call.path.endsWith("/authorize")).length, 1);
  mismatch = true;
  await assert.rejects(authorizePmTarget({ workspaceId, projectId: "PRJ-001" }, credentials), { code: "pm_reference_unavailable" });
});

test("unavailable PM never participates when no references were explicitly requested", async () => {
  status = 503;
  assert.deepEqual(await resolvePmReferences([], credentials), []);
  assert.deepEqual(await resolvePmReferenceOperations([], credentials), { references: [], operations: [] });
  assert.equal(calls.length, 0);
  assert.equal(pmContextPromptLine([]), undefined);
  assert.equal(pmContextPromptLine(undefined), undefined);
});

test("forged or inaccessible reference targets fail closed", async () => {
  mismatch = true;
  await assert.rejects(resolvePmReferences([reference], credentials), { code: "pm_reference_invalid" });
  mismatch = false;
  for (const denied of [401, 403, 404]) {
    status = denied;
    await assert.rejects(resolvePmReferences([reference], credentials), { code: "pm_reference_forbidden" });
  }
  status = 503;
  await assert.rejects(resolvePmReferences([reference], credentials), { code: "pm_reference_unavailable" });
  await assert.rejects(resolvePmReferences([{ ...reference, workspaceId: "forged" }], credentials));
});

test("revoked/deleted references reject admission; pinned stale references stay traceable", async () => {
  for (const value of ["forbidden", "deleted"] as const) {
    availability = value;
    const resolved = await resolvePmReferences([reference], credentials);
    assert.throws(() => assertResolvedReferences(resolved), { code: value === "forbidden" ? "pm_reference_forbidden" : "pm_reference_unavailable" });
    await assert.rejects(resolvePmReferenceOperations([reference], credentials));
  }
  availability = "stale";
  const resolved = await resolvePmReferences([{ ...reference, revision: "pinned-revision" }], credentials);
  assert.doesNotThrow(() => assertResolvedReferences(resolved));
  const prompt = pmContextPromptLine(resolved)!;
  assert.match(prompt, /TASK-001/); assert.match(prompt, /PRJ-001/); assert.match(prompt, new RegExp(workspaceId));
  assert.doesNotMatch(prompt, /pm_v4_session|Bearer|cookie|http:\/\//);
  assert.match(prompt, /不得假设代码目录包含/);
});
