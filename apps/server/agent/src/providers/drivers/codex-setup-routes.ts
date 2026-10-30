import { Hono } from "hono";
import { beginProviderAccountOperation, resetAuthState } from "../auth.ts";
import { getStoredInstance, providerContext, updateProviderInstance } from "../instances.ts";
import { sanitizeErrorText } from "../verify.ts";
import { codexProfiles, removeCodexProfile, selectCodexProfile } from "./codex-chatgpt-auth.ts";

export const codexSetupRoutes = new Hono();
function contextFor(instanceId: string) {
  const instance = getStoredInstance(instanceId);
  if (!instance || instance.driver !== "codex") throw Object.assign(new Error("Unknown Codex instance."), { status: 404 });
  if (!instance.enabled || instance.config.setupMode !== "managed") throw Object.assign(new Error("Managed Codex is not enabled."), { status: 409 });
  return instance;
}
codexSetupRoutes.get("/:instanceId/codex/profiles", async (c) => {
  try { const instance = contextFor(c.req.param("instanceId")); return c.json({ profiles: await codexProfiles(providerContext(instance)) }); }
  catch (error) { const status = error && typeof error === "object" && "status" in error && error.status === 404 ? 404 : 409; return c.json({ error: sanitizeErrorText(error instanceof Error ? error.message : "Could not read Codex profiles.") }, status); }
});
codexSetupRoutes.delete("/:instanceId/codex/profiles/:profileId", async (c) => {
  try {
    const instanceId = c.req.param("instanceId"); contextFor(instanceId); const id = c.req.param("profileId");
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(id)) return c.json({ error: "Invalid ChatGPT profile ID." }, 400);
    const reader = c.req.raw.body?.getReader(); let text = ""; const decoder = new TextDecoder();
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      if (text.length > 16384) { await reader.cancel(); return c.json({ error: "Request body is too large." }, 413); }
    }
    let body: { revision?: unknown };
    try { body = JSON.parse(text) as { revision?: unknown }; } catch { return c.json({ error: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object" || !Number.isSafeInteger(body.revision)) return c.json({ error: "A revision is required." }, 400);
    const release = beginProviderAccountOperation(instanceId);
    try {
      const current = updateProviderInstance(instanceId, {}, body.revision as number);
      resetAuthState(instanceId);
      const profiles = await removeCodexProfile(providerContext(current), id);
      return c.json({ profiles, revision: current.revision });
    } finally { release(); }
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 404, 409].includes(error.status) ? error.status as 400 | 404 | 409 : 500;
    return c.json({ error: sanitizeErrorText(error instanceof Error ? error.message : "Could not remove the Codex profile.") }, status);
  }
});
codexSetupRoutes.post("/:instanceId/codex/profiles/:profileId/select", async (c) => {
  try {
    const instanceId = c.req.param("instanceId"); contextFor(instanceId); const id = c.req.param("profileId");
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(id)) return c.json({ error: "Invalid ChatGPT profile ID." }, 400);
    const reader = c.req.raw.body?.getReader(); let text = ""; const decoder = new TextDecoder();
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      if (text.length > 16384) { await reader.cancel(); return c.json({ error: "Request body is too large." }, 413); }
    }
    let body: { revision?: unknown };
    try { body = JSON.parse(text) as { revision?: unknown }; } catch { return c.json({ error: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object" || !Number.isSafeInteger(body.revision)) return c.json({ error: "A revision is required." }, 400);
    const release = beginProviderAccountOperation(instanceId);
    try {
      const current = updateProviderInstance(instanceId, {}, body.revision as number);
      resetAuthState(instanceId);
      const profiles = await selectCodexProfile(providerContext(current), id);
      return c.json({ profiles, revision: current.revision });
    } finally { release(); }
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 404, 409].includes(error.status) ? error.status as 400 | 404 | 409 : 500;
    return c.json({ error: sanitizeErrorText(error instanceof Error ? error.message : "Could not select the Codex profile.") }, status);
  }
});
