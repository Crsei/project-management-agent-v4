import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { OmpRpcError, ompRecordField, ompRecordString } from "./rpc.ts";

export interface OmpDiscoveredCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/** Uses get_available_commands, including native builtins; no fabricated Pi command catalog. */
export function parseOmpDiscoveredCommands(data: unknown): OmpDiscoveredCommands {
  const commands = ompRecordField(data, "commands");
  if (!Array.isArray(commands)) throw new OmpRpcError({ operation: "get_available_commands", detail: "Invalid command inventory" });
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const raw = ompRecordString(command, "name");
    const name = raw?.replace(/^\//, "").trim();
    if (!name || /\s/.test(name)) throw new OmpRpcError({ operation: "get_available_commands", detail: "Invalid command name" });
    if (seen.has(name)) continue;
    seen.add(name);
    const description = ompRecordString(command, "description");
    const hint = ompRecordString(ompRecordField(command, "input"), "hint");
    slashCommands.push({
      name,
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...(hint?.trim() ? { input: { hint: hint.trim() } } : {}),
    });
    if (ompRecordString(command, "source") === "skill") {
      const skillName = name.startsWith("skill:") ? name.slice(6) : name;
      if (skillName) skills.push({
        name: skillName,
        path: ompRecordString(command, "path") ?? `omp:skill:${skillName}`,
        enabled: true,
        ...(description?.trim() ? { description: description.trim() } : {}),
      });
    }
  }
  return { slashCommands, skills };
}

export function parseOmpCompactCommand(text: string): { readonly customInstructions?: string } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}
