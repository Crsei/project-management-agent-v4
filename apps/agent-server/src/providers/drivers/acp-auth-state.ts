// Ported from t3code/packages/provider-acp-registry/src/server/authenticationState.ts (MIT).
// A discovery session alone does not prove authentication; only a verified explicit login does.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { acpAuthenticationBinding } from "./acp-auth.ts";

const stateSchema = z.object({ binding: z.string(), authenticated: z.boolean() });
export async function readAcpAuthenticationConfirmation(context: ProviderDriverContext): Promise<boolean> {
  try {
    const state = stateSchema.parse(JSON.parse(await readFile(path.join(context.homeDirectory, ".acp-auth-state.json"), "utf8")));
    return state.binding === acpAuthenticationBinding(context) && state.authenticated;
  } catch { return false; }
}
export async function writeAcpAuthenticationConfirmation(context: ProviderDriverContext, authenticated: boolean): Promise<void> {
  await mkdir(context.homeDirectory, { recursive: true, mode: 0o700 });
  const destination = path.join(context.homeDirectory, ".acp-auth-state.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ binding: acpAuthenticationBinding(context), authenticated }), { mode: 0o600 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
