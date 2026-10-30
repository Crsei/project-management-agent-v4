import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class SecretStoreError extends Schema.TaggedError<SecretStoreError>()("SecretStoreError", {
  operation: Schema.Literals(["get", "set", "create", "random", "remove"]),
  resource: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() { return `Application private secret ${this.operation} failed.`; }
}
export const isSecretStoreError = Schema.is(SecretStoreError);
export const isSecretAlreadyExistsError = (error: SecretStoreError) =>
  error.cause instanceof Error && "code" in error.cause && error.cause.code === "EEXIST";
export class ServerSecretStore extends Context.Service<ServerSecretStore, {
  readonly directory?: string;
  readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (name: string, bytes: number) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}>()("t3/auth/ServerSecretStore") {}

