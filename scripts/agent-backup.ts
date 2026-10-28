import { createAgentBackup, restoreAgentBackup, verifyAgentBackup } from "../apps/agent-server/src/maintenance/agent-backup.ts";

const usage = `Offline Agent maintenance (no HTTP exports; never stops processes)
  pnpm agent:backup create --source <data-dir> --bundle <new-private-dir> --secrets exclude|include --stopped
  pnpm agent:backup restore --bundle <backup-dir> --target <separate-empty-dir> --stopped
  pnpm agent:backup verify --bundle <backup-dir> [--target <restored-dir>] --stopped

include: private 0700/0600 bundle includes API credentials, instance env and dedicated in-data-dir CLI homes.
exclude: omits those secrets plus endpoint/executable overrides; restores durable history/settings/model config,
clears native resume references, and requires explicit endpoint/credential configuration and CLI re-login.
Both modes contain private conversations. Neither mode includes .env.agent, global/external CLI homes,
PM PostgreSQL/Markdown/attachments or user project/source files; keep a separate existing PM backup.
Stop only the verified owning Agent service first. Stale locks fail closed; no process is killed.
Restore never writes the source and never overwrites a nonempty target. Do not start the restored service
until its environment, project access and secret policy have been reviewed explicitly.`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help" || !command) { console.log(usage); return; }
  if (!["create", "restore", "verify"].includes(command)) throw new Error("Unknown maintenance command. Use --help.");
  const values = new Map<string, string>();
  let stopped = false;
  const allowed = command === "create" ? ["--source", "--bundle", "--secrets"] : ["--bundle", "--target"];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--stopped") {
      if (stopped) throw new Error("Duplicate --stopped flag.");
      stopped = true; continue;
    }
    if (!allowed.includes(flag) || values.has(flag)) throw new Error("Unknown or duplicate maintenance option. Use --help.");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Maintenance option requires a value.");
    values.set(flag, value);
  }
  const bundle = values.get("--bundle");
  if (!bundle) throw new Error("Explicit --bundle is required.");
  if (command === "create") {
    const source = values.get("--source");
    const secrets = values.get("--secrets");
    if (!source || (secrets !== "include" && secrets !== "exclude")) throw new Error("Explicit --source and --secrets include|exclude are required.");
    const result = await createAgentBackup({ source, bundle, secrets, stopped });
    console.log(JSON.stringify({ operation: "created", secrets: result.secrets, providerInstances: result.providerInstances, coverage: result.coverage }));
  } else if (command === "restore") {
    const target = values.get("--target");
    if (!target) throw new Error("Explicit --target is required.");
    console.log(JSON.stringify({ operation: "restored-and-verified", coverage: restoreAgentBackup({ bundle, target, stopped }) }));
  } else {
    console.log(JSON.stringify({ operation: "verified", coverage: verifyAgentBackup({ bundle, target: values.get("--target"), stopped }) }));
  }
}

main().catch((error: unknown) => {
  // Never serialize objects/configuration or dump a stack that may contain provider data.
  console.error(error instanceof Error ? error.message : "Agent maintenance failed.");
  process.exitCode = 1;
});
