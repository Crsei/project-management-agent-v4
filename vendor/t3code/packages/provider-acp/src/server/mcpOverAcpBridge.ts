import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as AcpSchema from "effect-acp/compat";
import type { ProviderRuntimeHostBinding } from "@t3tools/provider-core/server/ProviderRuntimeHost";

const MAX_CONNECTIONS = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class AcpMcpOverAcpError extends Error {
  readonly _tag = "AcpMcpOverAcpError";
  override readonly name = "AcpMcpOverAcpError";
}
const bridgeError = (cause: unknown): AcpMcpOverAcpError => cause instanceof AcpMcpOverAcpError
  ? cause : new AcpMcpOverAcpError(cause instanceof Error ? cause.message : String(cause), { cause });

export interface AcpMcpOverAcpBridgeOptions {
  readonly servers: ProviderRuntimeHostBinding["mcpServers"];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly assertCurrent: Effect.Effect<void, Error>;
  readonly allocateConnectionId: Effect.Effect<string>;
}
export interface AcpMcpOverAcpBridge {
  readonly connect: (request: AcpSchema.ConnectMcpRequest) => Effect.Effect<AcpSchema.ConnectMcpResponse, AcpMcpOverAcpError>;
  readonly message: (request: AcpSchema.MessageMcpRequest) => Effect.Effect<AcpSchema.MessageMcpResponse, AcpMcpOverAcpError>;
  readonly notification: (request: AcpSchema.MessageMcpNotification) => Effect.Effect<void, AcpMcpOverAcpError>;
  readonly disconnect: (request: AcpSchema.DisconnectMcpRequest) => Effect.Effect<AcpSchema.DisconnectMcpResponse, AcpMcpOverAcpError>;
  readonly dispose: Effect.Effect<void>;
}
interface Connection {
  readonly transport: StdioClientTransport;
  readonly pending: Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  nextRequestId: number;
}

/** Only the generation-owned PM stdio server is exposed, including ACP-native MCP transport. */
export const makeAcpMcpOverAcpBridge = Effect.fn("AcpMcpOverAcpBridge.make")(function* (
  options: AcpMcpOverAcpBridgeOptions,
): Effect.fn.Return<AcpMcpOverAcpBridge> {
  const connections = new Map<string, Connection>();
  const admission = yield* Semaphore.make(1);
  const connectionFor = (connectionId: string) => Effect.suspend(() => {
    const connection = connections.get(connectionId);
    return connection ? Effect.succeed(connection)
      : Effect.fail(new AcpMcpOverAcpError("Unknown generation-owned MCP-over-ACP connection."));
  });
  const send = (connection: Connection, message: JSONRPCMessage) => options.assertCurrent.pipe(
    Effect.andThen(Effect.tryPromise({ try: async () => {
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES)
        throw new AcpMcpOverAcpError("MCP-over-ACP message exceeds 8 MiB.");
      await connection.transport.send(message);
    }, catch: bridgeError })), Effect.mapError(bridgeError),
  );
  const disconnect = Effect.fn("mcpOverAcpBridge.disconnect")(function* (request: AcpSchema.DisconnectMcpRequest) {
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const connection = yield* connectionFor(request.connectionId);
      connections.delete(request.connectionId);
      yield* Effect.tryPromise({ try: () => connection.transport.close(), catch: bridgeError });
      return {};
    }));
  });
  return {
    connect: request => admission.withPermit(Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      yield* restore(options.assertCurrent.pipe(Effect.mapError(bridgeError)));
      const server = options.servers.find(candidate => candidate.name === request.serverId);
      if (!server) return yield* Effect.fail(new AcpMcpOverAcpError("Unknown generation-owned ACP MCP server."));
      if (connections.size >= MAX_CONNECTIONS)
        return yield* Effect.fail(new AcpMcpOverAcpError("Too many MCP-over-ACP connections."));
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.environment)) if (value !== undefined) env[key] = value;
      const transport = new StdioClientTransport({ command: server.command, args: [...server.args], cwd: options.cwd, env, stderr: "ignore" });
      const connection: Connection = { transport, pending: new Map(), nextRequestId: 0 };
      const rejectPending = (error: Error) => {
        for (const pending of connection.pending.values()) pending.reject(error);
        connection.pending.clear();
      };
      transport.onerror = error => rejectPending(bridgeError(error));
      transport.onclose = () => rejectPending(new AcpMcpOverAcpError("Generation-owned MCP transport closed."));
      transport.onmessage = message => {
        if (!("id" in message) || message.id === undefined) return;
        if ("method" in message) {
          void transport.send({ jsonrpc: "2.0", id: message.id,
            error: { code: -32601, message: "This host does not accept MCP server-initiated requests." } }).catch(error => rejectPending(bridgeError(error)));
          return;
        }
        const pending = connection.pending.get(message.id);
        if (!pending) return;
        connection.pending.delete(message.id);
        if ("error" in message) pending.reject(new AcpMcpOverAcpError(message.error.message));
        else pending.resolve(message.result);
      };
      yield* restore(Effect.tryPromise({ try: () => transport.start(), catch: bridgeError })).pipe(
        Effect.onError(() => Effect.promise(() => transport.close())),
      );
      const connectionId = yield* options.allocateConnectionId;
      connections.set(connectionId, connection);
      return { connectionId };
    }))),
    message: request => Effect.gen(function* () {
      const connection = yield* connectionFor(request.connectionId);
      const id = ++connection.nextRequestId;
      const response = yield* Effect.tryPromise({ try: signal => {
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        const message = JSONRPCMessageSchema.parse({ jsonrpc: "2.0", id, method: request.method,
          ...(request.params == null ? {} : { params: request.params }) });
        const abort = () => {
          connection.pending.delete(id);
          void connection.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled",
            params: { requestId: id, reason: "ACP call interrupted" } }).catch(() => {});
          reject(new AcpMcpOverAcpError("MCP-over-ACP request interrupted."));
        };
        signal.addEventListener("abort", abort, { once: true });
        connection.pending.set(id, {
          resolve: value => { signal.removeEventListener("abort", abort); resolve(value); },
          reject: error => { signal.removeEventListener("abort", abort); reject(error); },
        });
        void Effect.runPromise(send(connection, message), { signal }).catch(error => {
          const pending = connection.pending.get(id); connection.pending.delete(id); pending?.reject(bridgeError(error));
        });
        return promise;
      }, catch: bridgeError });
      return response as AcpSchema.MessageMcpResponse;
    }),
    notification: request => Effect.gen(function* () {
      const connection = yield* connectionFor(request.connectionId);
      const message = yield* Effect.try({ try: () => JSONRPCMessageSchema.parse({ jsonrpc: "2.0", method: request.method,
        ...(request.params == null ? {} : { params: request.params }) }), catch: bridgeError });
      yield* send(connection, message);
    }),
    disconnect,
    dispose: Effect.uninterruptible(Effect.gen(function* () {
      let failures: Array<unknown> | undefined;
      for (const connectionId of connections.keys()) {
        const result = yield* Effect.exit(disconnect({ connectionId }));
        if (Exit.isFailure(result)) (failures ??= []).push(Cause.squash(result.cause));
      }
      if (failures) return yield* Effect.die(new AggregateError(failures, "Generation-owned MCP transports failed to close."));
    })),
  } satisfies AcpMcpOverAcpBridge;
});
