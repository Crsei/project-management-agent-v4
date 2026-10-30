import { Hono, type Context } from "hono";
import { z } from "zod";
import { pmToolCapabilitiesSchema } from "../../../../packages/agent-contracts/src/pm-capabilities.ts";

const timeoutMs = 30_000;
const querySchema = z.strictObject({
  workspaceId: z.uuid().toLowerCase(),
  projectId: z.string().regex(/^PRJ-\d+$/).optional(),
});
const deniedMessages: Record<401 | 403 | 404, string> = {
  401: "PM authentication is required.",
  403: "PM access denied.",
  404: "PM workspace or project not found.",
};

/** PM_API_URL is an origin only; embedded credentials, queries or fragments are refused. */
function pmOrigin(): URL {
  const base = new URL(process.env.PM_API_URL?.trim() || "http://127.0.0.1:4194");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid PM API origin");
  }
  return new URL(base.origin);
}

/** Forwards only the caller's session credentials; no other client header crosses the boundary. */
function pmHeaders(c: Context): Headers {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization"]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function unavailable(c: Context): Response {
  return c.json({ error: "PM capability service is unavailable." }, 503);
}

export const pmCapabilityRoutes = new Hono();

pmCapabilityRoutes.get("/pm-capabilities", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const projectId = c.req.query("projectId");
  const input = querySchema.safeParse({
    workspaceId: workspaceId ?? "",
    ...(projectId === undefined ? {} : { projectId }),
  });
  if (!input.success) return c.json({ error: "A workspace UUID and an optional PRJ- project ID are required." }, 400);
  let endpoint: URL;
  try {
    endpoint = new URL(`/api/v1/workspaces/${encodeURIComponent(input.data.workspaceId)}/agent-capabilities`, pmOrigin());
  } catch {
    return unavailable(c);
  }
  if (input.data.projectId) endpoint.searchParams.set("projectId", input.data.projectId);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET", headers: pmHeaders(c), redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return unavailable(c);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    const denied = response.status as 401 | 403 | 404;
    return c.json({ error: deniedMessages[denied] }, denied);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return unavailable(c);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailable(c);
  }
  const parsed = pmToolCapabilitiesSchema.safeParse(body);
  if (!parsed.success) return unavailable(c);
  return c.json(parsed.data);
});
