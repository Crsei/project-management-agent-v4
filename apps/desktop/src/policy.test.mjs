import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutePath,
  initialSetup,
  publicConfiguration,
  readLaunchArguments,
  remoteAddress,
  sameService,
  serviceRequestAllowed,
  safeDesktopMessage,
  trustedConnectionFrame,
  trustedWorkspaceFrame,
  workspacePartition,
} from "./policy.mjs";

test("remote connections use HTTPS except explicit loopback", () => {
  assert.equal(
    remoteAddress("https://workspace.example.com"),
    "https://workspace.example.com/pm",
  );
  assert.equal(
    remoteAddress("https://workspace.example.com/agent/workspace/"),
    "https://workspace.example.com/agent/workspace",
  );
  assert.equal(remoteAddress("https://workspace.example.com/pm/"), "https://workspace.example.com/pm");
  assert.equal(remoteAddress("http://127.0.0.1:3224"), "http://127.0.0.1:3224/pm");
  assert.equal(remoteAddress("http://localhost:3224"), "http://localhost:3224/pm");
  assert.equal(remoteAddress("http://[::1]:3224"), "http://[::1]:3224/pm");
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
  assert.equal(serviceRequestAllowed(`blob:${origin}/image-id`, origin), true);
  assert.equal(serviceRequestAllowed("blob:https://attacker.example/image-id", origin), false);
  assert.equal(serviceRequestAllowed("blob:null/image-id", origin), false);
  assert.equal(serviceRequestAllowed(null, origin), false);
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
    { mode: "remote", remoteUrl: "https://workspace.example.com/pm" },
  );
  assert.deepEqual(readLaunchArguments(["--local"]), { mode: "local" });
  assert.throws(() => readLaunchArguments(["--local", "--remote=https://workspace.example.com"]));
  assert.throws(() => readLaunchArguments(["--remote=https://workspace.example.com", "--local"]));
  assert.throws(() => readLaunchArguments(["--remote"]));
  assert.throws(() => readLaunchArguments(["--node=relative/node"]));
  assert.throws(() => absolutePath("relative/data", "Data directory"));
  assert.throws(() => absolutePath("/tmp/data\0secret", "Data directory"));
});

test("first account setup is explicit, validated and never part of public connection state", () => {
  const setup = { email: " owner@example.invalid ", name: " Owner ", password: "long local passphrase", workspaceName: " Private workspace " };
  assert.equal(initialSetup(undefined), undefined);
  assert.deepEqual(initialSetup(setup), { email: "owner@example.invalid", name: "Owner", password: setup.password, workspaceName: "Private workspace" });
  for (const invalid of [
    { ...setup, password: "too short" }, { ...setup, email: "invalid" },
    { ...setup, name: " " }, { ...setup, workspaceName: "" }, [],
  ]) assert.throws(() => initialSetup(invalid));
  const configuration = { mode: "local", remoteUrl: "", dataDir: "/private/workspace", projectRoot: "/private/workspace/projects", nodePath: "/private/node", setup, password: setup.password, databaseUrl: "postgresql://private" };
  const safe = publicConfiguration(configuration);
  assert.deepEqual(safe, { mode: "local", remoteUrl: "", dataDir: "/private/workspace", projectRoot: "/private/workspace/projects" });
  assert.equal(JSON.stringify(safe).includes(setup.password), false);
  assert.equal(publicConfiguration(configuration, true).nodePath, "/private/node");
});

test("local browser storage persists only for the same instance and origin, never remote", () => {
  const origin = "http://127.0.0.1:45913";
  const local = workspacePartition("local", origin, "instance-one");
  assert.match(local, /^persist:local-workspace-[a-f0-9]{64}$/);
  assert.equal(workspacePartition("local", origin, "instance-one"), local);
  assert.notEqual(workspacePartition("local", origin, "instance-two"), local);
  assert.notEqual(workspacePartition("local", "http://127.0.0.1:45914", "instance-one"), local);
  assert.notEqual(workspacePartition("remote", origin), local);
  assert.equal(workspacePartition("remote", origin), workspacePartition("remote", origin, "ignored-local-id"));
  assert.throws(() => workspacePartition("local", origin));
  assert.throws(() => workspacePartition("local", `${origin}/pm`, "instance-one"));
});

test("diagnostics retain actionable context but exclude known setup secrets and credential URLs", () => {
  const value = safeDesktopMessage("Cannot start PostgreSQL: postgresql://owner:database-secret@127.0.0.1/workspace password=database-secret token=private-token email owner@example.invalid passphrase long local passphrase", ["owner@example.invalid", "long local passphrase"]);
  assert.match(value, /Cannot start PostgreSQL/);
  for (const secret of ["database-secret", "private-token", "owner@example.invalid", "long local passphrase"])
    assert.equal(value.includes(secret), false);
  assert.equal(safeDesktopMessage(""), "");
  assert.equal(safeDesktopMessage(new Error("Missing bundled Node executable")), "Missing bundled Node executable");
});

test("native controls accept only the exact bundled top-level frame", () => {
  const url = "file:///desktop/connection.html";
  const frame = { url, detached: false, isDestroyed: () => false };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  assert.equal(trustedConnectionFrame({ sender: contents, senderFrame: frame }, contents, url), true);
  assert.equal(trustedConnectionFrame({ sender: contents, senderFrame: { url } }, contents, url), false);
  assert.equal(trustedConnectionFrame({ sender: {}, senderFrame: frame }, contents, url), false);
  frame.url = "https://remote.example/pm";
  assert.equal(trustedConnectionFrame({ sender: contents, senderFrame: frame }, contents, url), false);
  assert.equal(trustedConnectionFrame({ get sender() { throw new Error("disposed"); } }, contents, url), false);
});

test("workspace native controls reject subframes, guests, changed origins and invalidated frames", () => {
  const url = "http://127.0.0.1:45913/agent/workspace";
  const frame = { url, detached: false, isDestroyed: () => false };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(trustedWorkspaceFrame(event, contents, url), true);
  assert.equal(trustedWorkspaceFrame({ sender: contents, senderFrame: { url } }, contents, url), false);
  assert.equal(trustedWorkspaceFrame({ sender: {}, senderFrame: frame }, contents, url), false);
  assert.equal(trustedWorkspaceFrame({ sender: contents, senderFrame: null }, contents, url), false);
  for (const destination of [
    "https://remote.example/agent/workspace", "http://127.0.0.1:45914/agent/workspace",
    "http://localhost:45913/agent/workspace", "file:///desktop/connection.html", "about:blank",
  ]) {
    frame.url = destination;
    assert.equal(trustedWorkspaceFrame(event, contents, url), false, destination);
  }
  frame.url = url;
  assert.equal(trustedWorkspaceFrame(event, { ...contents, isDestroyed: () => true }, url), false);
  assert.equal(trustedWorkspaceFrame({ get sender() { throw new Error("disposed"); } }, contents, url), false);
  assert.equal(trustedWorkspaceFrame(event, contents, null), false);
});

test("queued desktop IPC fails closed for detached, destroyed and replaced top-level frames", () => {
  for (const [trust, url] of [
    [trustedConnectionFrame, "file:///desktop/connection.html"],
    [trustedWorkspaceFrame, "http://127.0.0.1:45913/pm"],
  ]) {
    const frame = { url, detached: false, isDestroyed: () => false };
    const contents = { isDestroyed: () => false, mainFrame: frame };
    const event = { sender: contents, senderFrame: frame };
    assert.equal(trust(event, contents, url), true);
    frame.detached = true;
    assert.equal(trust(event, contents, url), false);
    frame.detached = false;
    frame.isDestroyed = () => true;
    assert.equal(trust(event, contents, url), false);
    frame.isDestroyed = () => { throw new Error("frame already disposed"); };
    assert.equal(trust(event, contents, url), false);
    frame.isDestroyed = () => false;
    contents.mainFrame = { ...frame };
    assert.equal(trust(event, contents, url), false);
    contents.mainFrame = frame;
    assert.equal(trust({ sender: contents, get senderFrame() { throw new Error("invalidated request"); } }, contents, url), false);
    assert.equal(trust(event, { ...contents, isDestroyed() { throw new Error("contents disposed"); } }, url), false);
  }
});
