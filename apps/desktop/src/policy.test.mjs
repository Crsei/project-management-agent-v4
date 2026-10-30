import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutePath,
  readLaunchArguments,
  remoteAddress,
  sameService,
  serviceRequestAllowed,
} from "./policy.mjs";

test("remote connections use HTTPS except explicit loopback", () => {
  assert.equal(
    remoteAddress("https://workspace.example.com"),
    "https://workspace.example.com/agent/workspace",
  );
  assert.equal(
    remoteAddress("https://workspace.example.com/agent/workspace/"),
    "https://workspace.example.com/agent/workspace",
  );
  assert.equal(remoteAddress("http://127.0.0.1:3224"), "http://127.0.0.1:3224/agent/workspace");
  assert.equal(remoteAddress("http://localhost:3224"), "http://localhost:3224/agent/workspace");
  assert.equal(remoteAddress("http://[::1]:3224"), "http://[::1]:3224/agent/workspace");
  for (const value of [
    "http://workspace.example.com",
    "http://192.168.1.3",
    "http://127.0.0.1.attacker.example",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@workspace.example.com",
    "https://workspace.example.com/?token=secret",
    "https://workspace.example.com/#secret",
    "https://workspace.example.com/api",
  ]) {
    assert.throws(() => remoteAddress(value), undefined, value);
  }
});

test("workspace requests and navigations cannot escape their exact service origin", () => {
  const origin = "http://127.0.0.1:45913";
  assert.equal(sameService(`${origin}/agent/workspace`, origin), true);
  assert.equal(serviceRequestAllowed("ws://127.0.0.1:45913/agent/api/terminal", origin), true);
  assert.equal(
    serviceRequestAllowed(
      "wss://workspace.example.com/api/terminal",
      "https://workspace.example.com",
    ),
    true,
  );
  assert.equal(serviceRequestAllowed("data:image/png;base64,aA==", origin), true);
  for (const value of [
    "http://127.0.0.1:45914/api/access",
    "https://127.0.0.1:45913/api/access",
    "http://localhost:45913/api/access",
    "https://attacker.example/",
    "http://user:secret@127.0.0.1:45913",
    "file:///etc/passwd",
  ]) {
    assert.equal(sameService(value, origin), false, value);
    assert.equal(serviceRequestAllowed(value, origin), false, value);
  }
});

test("launch mode is deliberate and credential-free", () => {
  assert.deepEqual(
    readLaunchArguments(["--remote=https://workspace.example.com", "--disable-gpu"]),
    { mode: "remote", remoteUrl: "https://workspace.example.com/agent/workspace" },
  );
  assert.deepEqual(readLaunchArguments(["--local"]), { mode: "local" });
  assert.throws(() => readLaunchArguments(["--local", "--remote=https://workspace.example.com"]));
  assert.throws(() => readLaunchArguments(["--remote=https://workspace.example.com", "--local"]));
  assert.throws(() => readLaunchArguments(["--remote"]));
  assert.throws(() => readLaunchArguments(["--node=relative/node"]));
  assert.throws(() => absolutePath("relative/data", "Data directory"));
  assert.throws(() => absolutePath("/tmp/data\0secret", "Data directory"));
});
