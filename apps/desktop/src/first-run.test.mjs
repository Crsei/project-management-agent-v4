import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { completeFirstRunSetup, readSetupStatus } from "./first-run.mjs";

const token = "A".repeat(43);
const credentials = { email: "owner@example.invalid", password: "local-password-4738", name: "Owner", workspaceName: "Workspace" };

async function server(t, handler) {
  const mock = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => handler({ request, response, body }));
  });
  await new Promise(done => mock.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => mock.close(done)));
  return `http://127.0.0.1:${mock.address().port}`;
}

test("first-run status requires the strict invite-only contract", async t => {
  let valid = true;
  const origin = await server(t, ({ response }) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(valid
      ? { initialized: false, setupAllowed: true, registrationMode: "invite_only" }
      : { initialized: false, setupAllowed: true, registrationMode: "public" }));
  });
  assert.deepEqual(await readSetupStatus(origin), { initialized: false, setupAllowed: true, registrationMode: "invite_only" });
  valid = false;
  await assert.rejects(readSetupStatus(origin), /invalid/);
});

test("first-run setup posts the prepared token and reports only the server error code", async t => {
  let requestBody;
  let fail = false;
  const origin = await server(t, ({ request, response, body }) => {
    requestBody = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    if (fail) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: { code: "setup_token_invalid" } }));
      return;
    }
    assert.equal(request.headers.origin, origin);
    response.end(JSON.stringify({
      actor: { id: "11111111-2222-4333-8444-555555555555", email: credentials.email, name: credentials.name },
      workspaceId: "22222222-2222-4333-8444-555555555555",
      expiresAt: new Date().toISOString(),
    }));
  });
  const result = await completeFirstRunSetup({ origin, setupToken: token, credentials });
  assert.equal(result.workspaceId, "22222222-2222-4333-8444-555555555555");
  assert.deepEqual(requestBody, { setupToken: token, ...credentials });
  fail = true;
  await assert.rejects(completeFirstRunSetup({ origin, setupToken: token, credentials }), error => {
    assert.match(error.message, /setup_token_invalid/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  await assert.rejects(completeFirstRunSetup({ origin, setupToken: "short", credentials }), /token is unavailable/);
});
