import os from "node:os";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ProviderDriverContext } from "../../driver-adapter.ts";

// Providers own child-process input, never the PM server's interactive terminal.
const processServices = Layer.provideMerge(NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer, NodeStdio.layer));

/** Retain native command options and pipes without inheriting the PM server environment. */
export function bindPmProviderCommand(command: ChildProcess.Command, context: ProviderDriverContext): ChildProcess.Command {
  if (command._tag === "PipedCommand") return ChildProcess.pipeTo(
    bindPmProviderCommand(command.left, context), bindPmProviderCommand(command.right, context), command.options,
  );
  return ChildProcess.make(command.command, command.args, {
    ...command.options, cwd: command.options.cwd ?? context.cwd,
    env: command.options.env && command.options.extendEnv === false ? command.options.env : { ...context.env, ...command.options.env },
    extendEnv: false,
  });
}

/** The process-only platform is also usable while constructing the concrete AgentScope layer. */
export function makePmProviderProcessPlatformLayer(context: ProviderDriverContext) {
  const spawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make(command => native.spawn(bindPmProviderCommand(command, context)));
  })).pipe(Layer.provide(processServices));
  return Layer.mergeAll(processServices, spawner,
    Layer.succeed(HostProcess.Environment, { ...context.env }),
    Layer.succeed(HostProcess.WorkingDirectory, context.cwd),
    Layer.succeed(HostProcess.HomeDirectory, context.env.HOME || context.env.USERPROFILE || os.homedir()));
}
