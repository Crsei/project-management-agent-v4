import * as Context from "effect/Context";

/** Only provider-consumed host paths; this is not the t3 server application config. */
export class ServerConfig extends Context.Service<ServerConfig, {
  readonly cwd: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  readonly attachmentsDir: string;
  readonly secretsDir: string;
  readonly environmentIdPath: string;
}>()("t3/config/ServerConfig") {}
