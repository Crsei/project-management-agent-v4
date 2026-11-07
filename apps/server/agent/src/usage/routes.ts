import { Hono } from "hono";
import { z } from "zod";
import { providerConsumeResetCreditInputSchema, usageLimitSourceInputSchema, usageSettingsUpdateSchema, usageSummaryInputSchema } from "@agent-workspace/contracts/usage";
import { DurableError } from "../durable/errors.ts";
import { getThread, validThreadId } from "../durable/threads.ts";
import { readUsageSummary, UsageInputError } from "./service.ts";
import { getUsageSettings, updateUsageSettings } from "./settings.ts";
import { getUsageLimitsReport, refreshUsageLimits, consumeUsageReset } from "./limits.ts";
import { listUsageSources, createUsageSource, updateUsageSource, deleteUsageSource } from "./hubs.ts";
import { getThreadUsage } from "./ledger.ts";

export const usageRoutes = new Hono();
usageRoutes.onError((error, c) => {
  if (error instanceof DurableError || error instanceof UsageInputError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: "Invalid usage request.", code: "invalid_request" }, 400);
  // Domain errors carry safe status and message; never return provider/HTTP exceptions verbatim.
  if ("status" in error && typeof error.status === "number" && [400, 403, 404, 409, 412].includes(error.status))
    return c.json({ error: error.message, code: "code" in error && typeof error.code === "string" ? error.code : error.status === 409 ? "conflict" : "invalid_request" }, error.status as 400 | 403 | 404 | 409 | 412);
  console.error("Usage request failed:", error.name);
  return c.json({ error: "Unable to read or update usage.", code: "usage_error" }, 500);
});
usageRoutes.post("/usage/summary", async (c) => c.json(await readUsageSummary(usageSummaryInputSchema.parse(await c.req.json()))));
usageRoutes.post("/usage/refresh", async (c) => c.json(await readUsageSummary({ ...usageSummaryInputSchema.parse(await c.req.json()), awaitRefresh: true })));
usageRoutes.get("/usage/settings", (c) => c.json(getUsageSettings()));
usageRoutes.patch("/usage/settings", async (c) => c.json(updateUsageSettings(usageSettingsUpdateSchema.parse(await c.req.json()))));
usageRoutes.get("/usage/limits", (c) => c.json(getUsageLimitsReport()));
usageRoutes.post("/usage/limits/refresh", async (c) => {
  const input = z.object({ instanceIds: z.array(z.string().trim().min(1).max(512)).max(100).optional() }).strict().parse(await c.req.json());
  return c.json(await refreshUsageLimits(input.instanceIds, c.req.raw.signal));
});
usageRoutes.post("/usage/limits/reset", async (c) => c.json(await consumeUsageReset(providerConsumeResetCreditInputSchema.parse(await c.req.json()))));
usageRoutes.get("/usage/sources", (c) => c.json({ sources: listUsageSources() }));
usageRoutes.post("/usage/sources", async (c) => c.json({ source: createUsageSource(usageLimitSourceInputSchema.parse(await c.req.json())) }));
usageRoutes.put("/usage/sources/:id", async (c) => {
  const input = usageLimitSourceInputSchema.extend({ revision: z.number().int().nonnegative().safe() }).parse(await c.req.json());
  return c.json({ source: updateUsageSource(c.req.param("id"), input) });
});
usageRoutes.delete("/usage/sources/:id", (c) => {
  const revision = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int().nonnegative().safe()).parse(c.req.query("revision"));
  deleteUsageSource(c.req.param("id"), revision);
  return c.json({ deleted: true });
});
usageRoutes.get("/usage/threads/:threadId", async (c) => {
  const id = c.req.param("threadId");
  if (!validThreadId(id)) throw new UsageInputError("Invalid thread ID.");
  const thread = getThread(id);
  if (!thread) throw new DurableError(404, "not_found", "找不到该会话。");
  return c.json(getThreadUsage(id));
});
