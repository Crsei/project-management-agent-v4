import { chmod, writeFile } from "node:fs/promises";
import type { OpenCodeGeneration } from "./opencode-protocol-fixture.ts";

export interface OpenCodeCliVersionState {
  readonly stdout: string;
  readonly version: string;
}

/** Version and serve share one explicit state file, including after fake npm updates. */
export async function writeOpenCodeCliFixture(input: {
  readonly binaryPath: string;
  readonly generation: OpenCodeGeneration;
  readonly versionStatePath: string;
  /** Append-only JSONL of actual serve processes, excluding short-lived version probes. */
  readonly processRecordPath?: string;
}): Promise<void> {
  const source = `#!${process.execPath}
// This generated fixture exercises both .mjs and extensionless npm launchers;
// dynamic imports are required so the same controlled script also runs as CJS.
void (async () => {
  const fs = await import("node:fs");
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(input.versionStatePath)}, "utf8"));
  if (process.argv.includes("--version")) { console.log(state.stdout); return; }
  if (process.argv[2] !== "serve") throw new Error("Unsupported controlled CLI command");
  const argument = process.argv.find(value => value.startsWith("--port="));
  const port = Number(argument?.slice("--port=".length));
  if (!Number.isInteger(port) || port < 1) throw new Error("Missing requested listening port");
  const { createOpenCodeProtocolFixture } = await import(${JSON.stringify(new URL("./opencode-protocol-fixture.ts", import.meta.url).href)});
  const password = process.env.${input.generation === "v2" ? "OPENCODE_PASSWORD" : "OPENCODE_SERVER_PASSWORD"} ?? "";
  const fixture = await createOpenCodeProtocolFixture({ generation: ${JSON.stringify(input.generation)}, cwd: process.cwd(), password, port, version: state.version });
  ${input.processRecordPath ? `fs.appendFileSync(${JSON.stringify(input.processRecordPath)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME, data: process.env.XDG_DATA_HOME, wrongPasswordPresent: process.env.${input.generation === "v2" ? "OPENCODE_SERVER_PASSWORD" : "OPENCODE_PASSWORD"} !== undefined }) + "\\n", { mode: 0o600 });` : ""}
  console.log("OpenCode server listening on " + fixture.url);
})().catch(() => { console.error("controlled_opencode_cli_failed"); process.exitCode = 93; });
`;
  await writeFile(input.binaryPath, source, { mode: 0o700 });
  await chmod(input.binaryPath, 0o700);
}
