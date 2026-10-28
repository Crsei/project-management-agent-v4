import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import { accessGuard, accessRoutes, assertNetworkBinding, authorizeHeaders } from "./access.ts";

const original = process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
after(() => {
  if (original === undefined) delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  else process.env.AGENT_WORKSPACE_ACCESS_TOKEN = original;
});
const app = new Hono()
  .route("/api", accessRoutes)
  .use("/api/*", accessGuard)
  .get("/api/private", (c) => c.json({ allowed: true }));

test("local access rejects cross-origin and DNS-rebinding hosts", async () => {
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  assert.equal(
    (await app.request("http://localhost/api/private", { headers: { host: "localhost" } })).status,
    200,
  );
  assert.equal(
    (
      await app.request("http://localhost/api/private", {
        headers: { host: "localhost", origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.request("http://evil.invalid/api/private", { headers: { host: "evil.invalid" } }))
      .status,
    401,
  );
  assert.equal(
    (
      await app.request("http://localhost/api/private", {
        headers: { host: "localhost", "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
});

test("remote authorization uses an HttpOnly cookie and token rotation revokes it", async () => {
  const token = "access-test-" + "a".repeat(40);
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  const headers = {
    host: "workspace.example",
    origin: "https://workspace.example",
    "content-type": "application/json",
  };
  const rejected = await app.request("https://workspace.example/api/access", {
    method: "POST",
    headers,
    body: JSON.stringify({ token: "wrong" }),
  });
  assert.equal(rejected.status, 401);
  const accepted = await app.request("https://workspace.example/api/access", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie")!;
  assert.match(cookie, /^agent_v3_access=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Secure/i);
  assert.equal(cookie.includes(token), false);
  const sessionHeaders = new Headers({ ...headers, cookie: cookie.split(";")[0] });
  assert.equal(authorizeHeaders(sessionHeaders), true);
  assert.equal(
    (await app.request("https://workspace.example/api/private", { headers: sessionHeaders }))
      .status,
    200,
  );
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "access-test-" + "b".repeat(40);
  assert.equal(authorizeHeaders(sessionHeaders), false);
});

test("network binding cannot rely on a spoofable Host header for remote access", () => {
  const proxy = process.env.AGENT_WORKSPACE_LOOPBACK_PROXY;
  delete process.env.AGENT_WORKSPACE_LOOPBACK_PROXY;
  delete process.env.AGENT_WORKSPACE_ACCESS_TOKEN;
  try {
    assert.throws(() => assertNetworkBinding("0.0.0.0"));
    assert.throws(() => assertNetworkBinding(true));
    assertNetworkBinding("127.0.0.1");
    process.env.AGENT_WORKSPACE_ACCESS_TOKEN = "binding-test-" + "x".repeat(40);
    assertNetworkBinding("0.0.0.0");
  } finally {
    if (proxy === undefined) delete process.env.AGENT_WORKSPACE_LOOPBACK_PROXY;
    else process.env.AGENT_WORKSPACE_LOOPBACK_PROXY = proxy;
  }
});
