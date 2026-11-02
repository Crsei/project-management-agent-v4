import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import { checkOmpProviderStatus, parseOmpAuthentication, parseOmpDiscoveredModels, parseOmpThinkingLevels } from "./status.ts";
import { makeOmpTestProcess } from "./transportTestHelpers.ts";
import { parseOmpDiscoveredCommands } from "./commands.ts";

const settings = { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] } as const;
const model = { provider: "local", id: "model", name: "Native model", reasoning: true, thinking: { efforts: ["low", "high", "xhigh"] } };

 describe("OMP native discovery", () => {
  it("does not infer paid authentication from a nonempty model inventory", () => {
    const models = parseOmpDiscoveredModels({ models: [model] }, { model }, { levels: ["off", "low", "high", "xhigh"] });
    assert.lengthOf(models, 1);
    assert.equal(parseOmpAuthentication({ providers: [] }, { model }).status, "unknown");
    assert.equal(parseOmpAuthentication({ providers: [{ id: "other", authenticated: true }] }, { model }).status, "unknown");
    assert.equal(parseOmpAuthentication({ providers: [{ id: "local", authenticated: false }] }, { model }).status, "unauthenticated");
    assert.equal(parseOmpAuthentication({ providers: [{ id: "local", authenticated: true }] }, { model }).status, "authenticated");
  });

  it("uses live effort discovery for the selected model and canonical per-model efforts for others", () => {
    const models = parseOmpDiscoveredModels({ models: [model, { ...model, id: "other", thinking: { efforts: ["medium"] } }, { provider: "unknown", id: "opaque", reasoning: true }] }, { model, thinkingLevel: "xhigh" }, { levels: ["off", "xhigh"] });
    const descriptor = models[0]!.capabilities?.optionDescriptors?.[0];
    assert.equal(descriptor?.type, "select");
    if (descriptor?.type === "select") assert.deepEqual(descriptor.options.map((option) => option.id), ["off", "xhigh"]);
    assert.lengthOf(models[2]!.capabilities?.optionDescriptors ?? [], 0);
    assert.throws(() => parseOmpThinkingLevels({ levels: ["inherit"] }));
    assert.throws(() => parseOmpDiscoveredModels({ models: [{ provider: "native" }] }, {}, { levels: ["off"] }));
  });

  it("discovers actual builtin and skill commands instead of fabricating a Pi catalog", () => {
    const result = parseOmpDiscoveredCommands({ commands: [
      { name: "compact", source: "builtin", description: "Native compact", input: { hint: "Instructions" } },
      { name: "skill:inspect", source: "skill", description: "Inspect current project" },
    ] });
    assert.deepEqual(result.slashCommands.map((command) => command.name), ["compact", "skill:inspect"]);
    assert.equal(result.slashCommands[0]?.input?.hint, "Instructions");
    assert.equal(result.skills[0]?.name, "inspect");
    assert.throws(() => parseOmpDiscoveredCommands({}));
  });

  it.effect("runs version, ready/v2, model/commands/effort/auth discovery against the native process boundary", () => Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-status-"))),
      (path) => Effect.sync(() => Fs.rmSync(path, { recursive: true, force: true })),
    );
    const process = yield* makeOmpTestProcess({ onRequest: (request, controls) => controls.reply(request,
      request.type === "get_available_models" ? { models: [model] }
        : request.type === "get_state" ? { model, thinkingLevel: "xhigh" }
        : request.type === "get_available_thinking_levels" ? { levels: ["off", "low", "high", "xhigh"] }
        : request.type === "get_available_commands" ? { commands: [{ name: "compact", source: "builtin" }] }
        : request.type === "get_login_providers" ? { providers: [] } : {},
    ) });
    const launches: ChildProcess.StandardCommand[] = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected OMP command pipeline");
      launches.push(command);
      return process.spawner.spawn(command);
    });
    const snapshot = yield* checkOmpProviderStatus(
      { ...settings, binaryPath: "bin/omp" },
      { HOME: root, AGENT_OMP_GATE: "stale" },
      root,
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    assert.equal(snapshot.version, "18.13.2");
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.auth.status, "unknown");
    assert.deepEqual(snapshot.models.map((model) => model.slug), ["local/model"]);
    assert.deepEqual(snapshot.slashCommands.map((command) => command.name), ["compact"]);
    assert.deepEqual(process.received.map((request) => request.type), ["negotiate_protocol", "get_available_models", "get_state", "get_available_thinking_levels", "get_available_commands", "get_login_providers"]);
    assert.lengthOf(launches, 2);
    for (const launch of launches) {
      assert.equal(launch.options.cwd, root);
      assert.equal(launch.options.env?.HOME, root);
      assert.isUndefined(launch.options.env?.AGENT_OMP_GATE);
    }
    assert.include(launches[0]!.args, "--version");
  }).pipe(Effect.scoped));

  it.effect("refuses unsafe native startup before even a version process is spawned", () => Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-status-deny-"))),
      (path) => Effect.sync(() => Fs.rmSync(path, { recursive: true, force: true })),
    );
    Fs.writeFileSync(Path.join(root, "mcp.json"), "must not be read");
    const process = yield* makeOmpTestProcess();
    const snapshot = yield* checkOmpProviderStatus(settings, { HOME: root }, root).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, process.spawner));
    assert.equal(snapshot.status, "error");
    assert.include(snapshot.message ?? "", "startup refused");
    assert.lengthOf(process.launches, 0);
  }).pipe(Effect.scoped));
});
