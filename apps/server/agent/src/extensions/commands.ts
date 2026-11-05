import { z } from "zod";
import { extensionAppIds } from "@agent-workspace/contracts/extensions";
import { ExtensionError } from "./rpc.ts";

const id = z.string().min(1).max(300).refine(value => !/[\0\r\n]/.test(value) && !value.includes("__CC_SWITCH_SECRET_"));
const app = z.enum(extensionAppIds);
const relative = z.string().min(1).max(1000).refine(value => !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some(part => part === ".." || part === "."));
const apps = z.partialRecord(z.enum(extensionAppIds), z.boolean());
const repo = z.strictObject({ owner: id, name: id, branch: id, enabled: z.boolean() });
const skill = z.object({ key: id, name: id, description: z.string().max(20000), directory: relative, repoOwner: id, repoName: id, repoBranch: id, readmeUrl: z.string().max(4000).nullish() }).strict();
const configuration = z.unknown().superRefine((value, ctx) => {
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (typeof item !== "object" || !item || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    return Object.entries(item).every(([name, child]) => !["__proto__", "prototype", "constructor"].includes(name) && !name.includes("\0") && !name.includes("__CC_SWITCH_SECRET_") && visit(child, depth + 1));
  };
  if (!visit(value, 0)) ctx.addIssue({ code: "custom", message: "Configuration must be bounded JSON without reserved object keys." });
}).pipe(z.record(z.string(), z.unknown()));
const metadata = { id, name: id, server: configuration, description: z.string().max(20000).nullish(), homepage: z.string().max(4000).nullish(), docs: z.string().max(4000).nullish(), tags: z.array(z.string().max(200)).max(100).optional() };
const definition = z.strictObject({ ...metadata, description: z.string().max(20000).optional(), homepage: z.string().max(4000).optional(), docs: z.string().max(4000).optional() });
const server = z.strictObject({ ...metadata, apps });
const empty = z.strictObject({});
export const extensionCommandSchemas = {
  get_mcp_servers: empty,
  get_mcp_management: empty,
  save_mcp_definition: z.strictObject({ definition }),
  set_mcp_agent_configuration: z.strictObject({ serverId: id, app, enabled: z.boolean(), override: configuration.nullable().optional() }),
  preview_mcp_import: empty,
  apply_mcp_import: z.strictObject({
    previewId: id,
    selections: z.array(z.strictObject({ entryId: id, resolution: z.enum(["import", "merge-override", "skip"]) })).max(10000).refine(items => new Set(items.map(item => item.entryId)).size === items.length, "Select each preview entry at most once."),
  }),
  upsert_mcp_server: z.strictObject({ server }),
  delete_mcp_server: z.strictObject({ id }),
  toggle_mcp_app: z.strictObject({ serverId: id, app, enabled: z.boolean() }),
  resync_mcp_to_apps: z.strictObject({ apps: z.array(app).nullable().optional() }),
  start_mcp_connectivity_checks: z.strictObject({ serverIds: z.array(id).min(1).max(100) }),
  cancel_mcp_connectivity_checks: z.strictObject({ batchId: id }),
  validate_mcp_command: z.strictObject({ cmd: z.string().min(1).max(1000).refine(value => !/[\0\r\n]/.test(value)) }),
  get_installed_skills: empty,
  get_skill_backups: empty,
  scan_unmanaged_skills: empty,
  get_skill_repos: empty,
  get_settings: empty,
  delete_skill_backup: z.strictObject({ backupId: id }),
  install_skill_unified: z.strictObject({ skill, currentApp: app }),
  uninstall_skill_unified: z.strictObject({ id }),
  restore_skill_backup: z.strictObject({ backupId: id, currentApp: app }),
  toggle_skill_app: z.strictObject({ id, app, enabled: z.boolean() }),
  import_skills_from_apps: z.strictObject({ imports: z.array(z.strictObject({ directory: relative, apps })).max(1000) }),
  discover_available_skills: z.strictObject({ forceRefresh: z.boolean().optional() }),
  discover_repo_skills: z.strictObject({ owner: id, name: id }),
  check_skill_updates: empty,
  resync_skills_to_apps: empty,
  update_skill: z.strictObject({ id }),
  migrate_skill_storage: z.strictObject({ target: z.enum(["cc_switch", "unified"]) }),
  search_skills_sh: z.strictObject({ query: z.string().max(1000), limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(100000) }),
  add_skill_repo: z.strictObject({ repo }),
  remove_skill_repo: z.strictObject({ owner: id, name: id }),
  install_skills_from_zip: z.strictObject({ uploadId: z.uuid(), currentApp: app }),
  save_settings: z.strictObject({ settings: z.strictObject({ skillSyncMethod: z.enum(["auto", "symlink", "copy"]).optional(), skillStorageLocation: z.enum(["cc_switch", "unified"]).optional(), backupRetainCount: z.number().int().min(0).max(4294967295).nullish(), language: z.string().max(20).nullish(), visibleApps: z.record(z.string(), z.boolean()).optional() }) }),
  browse_directory: z.strictObject({ kind: z.enum(["skills", "skill"]), directory: relative.optional(), subdirectory: relative.optional() }),
  read_skill_file: z.strictObject({ directory: relative, file: relative }),
} satisfies Record<string, z.ZodType>;
export type ExtensionCommand = keyof typeof extensionCommandSchemas;
export const extensionMutationCommands: Partial<Record<ExtensionCommand, true>> = {
  upsert_mcp_server: true, save_mcp_definition: true, set_mcp_agent_configuration: true, apply_mcp_import: true, delete_mcp_server: true, toggle_mcp_app: true, resync_mcp_to_apps: true,
  delete_skill_backup: true, install_skill_unified: true, uninstall_skill_unified: true, restore_skill_backup: true, toggle_skill_app: true,
  import_skills_from_apps: true, resync_skills_to_apps: true, update_skill: true, migrate_skill_storage: true, add_skill_repo: true,
  remove_skill_repo: true, install_skills_from_zip: true, save_settings: true,
};
export function isExtensionMutationCommand(command: ExtensionCommand): boolean { return extensionMutationCommands[command] === true; }
export function parseExtensionCommand(command: string, args: Record<string, unknown>): { command: ExtensionCommand; args: Record<string, unknown> } {
  if (!Object.hasOwn(extensionCommandSchemas, command)) throw new ExtensionError(403, "command_not_allowed", "This command is not exposed by the configuration host.");
  const name = command as ExtensionCommand;
  if (name === "save_mcp_definition" || name === "upsert_mcp_server") {
    const raw = args[name === "save_mcp_definition" ? "definition" : "server"];
    if (raw && typeof raw === "object" && Object.entries(raw).some(([field, value]) => field !== "server" && JSON.stringify(value)?.includes("__CC_SWITCH_SECRET_"))) throw new ExtensionError(409, "secret_mask_stale", "Protected configuration masks cannot be used in definition metadata.");
  }
  return { command: name, args: extensionCommandSchemas[name].parse(args) as Record<string, unknown> };
}
