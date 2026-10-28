import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  ProviderAuthState,
  ProviderAuthStreamEvent,
  ProviderInstance,
  ProviderDriver,
  ProviderInstanceInput,
  ProviderInstanceUpdate,
} from "@agent-workspace/contracts/provider";
import { getProviderDefinition, listProviderInstances, probeProviderInstance } from "./catalog.ts";
import { sanitizeErrorText } from "./verify.ts";
import { getNativeProviderAdapter, nativeProviderAdapters } from "./driver-registry.ts";
import { searchAcpRegistry } from "./drivers/acp-registry-support.ts";
import {
  cancelProviderAuth,
  getAuthState,
  logoutProvider,
  startProviderAuth,
  subscribeAuth,
  writeAuthInput,
} from "./auth.ts";
import { resetAuthState } from "./auth.ts";
import { checkProviderConnection } from "./checks.ts";
import {
  createProviderInstance,
  updateProviderInstance,
  deleteProviderInstance,
  getStoredInstance,
  providerContext,
} from "./instances.ts";

const MAX_BODY_BYTES = 16 * 1024;

class RouteError extends Error {
  status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "RouteError";
    this.status = status;
  }
}

type ErrorResponder = {
  json: (body: { error: string }, status: ContentfulStatusCode) => Response;
};

function respondError(context: ErrorResponder, error: unknown): Response {
  const status: ContentfulStatusCode =
    error instanceof RouteError
      ? error.status
      : error && typeof error === "object" && "status" in error && typeof error.status === "number"
        && error.status >= 400 && error.status <= 599 ? error.status as ContentfulStatusCode : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return context.json({ error: sanitizeErrorText(message || "Unexpected server error.") }, status);
}

function requireDefinition(instanceId: string) {
  const definition = getProviderDefinition(instanceId);
  if (!definition) throw new RouteError(404, `Unknown provider instance: ${instanceId}`);
  return definition;
}

function hasBody(request: Request): boolean {
  const length = Number(request.headers.get("content-length") ?? "0");
  return request.body !== null || (Number.isFinite(length) && length > 0) || request.headers.has("transfer-encoding");
}

function isJsonRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

async function readCappedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RouteError(413, "Request body is too large.");
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RouteError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RouteError(400, "Invalid JSON body.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RouteError(400, "Request body must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>; // validated above
  return record;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!isJsonRequest(request)) {
    throw new RouteError(415, "Content-Type must be application/json.");
  }
  const text = await readCappedBody(request);
  if (!text.trim()) throw new RouteError(400, "Request body is required.");
  return parseObject(text);
}

async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!hasBody(request)) return {};
  if (!isJsonRequest(request)) {
    throw new RouteError(415, "Content-Type must be application/json.");
  }
  const text = await readCappedBody(request);
  return text.trim() ? parseObject(text) : {};
}

export const providerRoutes = new Hono();

// Native auth state and configuration metadata must never enter a shared cache.
const providerGuard: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (
    c.req.method === "POST" ||
    c.req.method === "PUT" ||
    c.req.method === "PATCH" ||
    c.req.method === "DELETE"
  ) {
    if (c.req.method !== "DELETE" && !isJsonRequest(c.req.raw)) {
      return c.json({ error: "Content-Type must be application/json." }, 415);
    }
    if (hasBody(c.req.raw) && !isJsonRequest(c.req.raw)) {
      return c.json({ error: "Content-Type must be application/json." }, 415);
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json({ error: "Request body is too large." }, 413);
    }
  }
  await next();
};

providerRoutes.use("/providers", providerGuard);
providerRoutes.use("/providers/*", providerGuard);

providerRoutes.get("/providers", async (c) => {
  try {
    const providers: ProviderInstance[] = await listProviderInstances();
    return c.json({ providers, drivers: nativeProviderAdapters.map(adapter => adapter.definition) });
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.get("/providers/acp-registry/search", async (c) => {
  try {
    const query = c.req.query("q") ?? "";
    if (query.length > 200) throw new RouteError(400, "Search query is too long.");
    const limit = Number(c.req.query("limit") ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RouteError(400, "Invalid search limit.");
    return c.json(await searchAcpRegistry({ query, limit, signal: c.req.raw.signal }));
  } catch (error) { return respondError(c, error); }
});

function instanceInput(body: Record<string, unknown>, create: true): ProviderInstanceInput;
function instanceInput(body: Record<string, unknown>, create: false): ProviderInstanceUpdate;
function instanceInput(
  body: Record<string, unknown>,
  create: boolean,
): ProviderInstanceInput | ProviderInstanceUpdate {
  const result: ProviderInstanceUpdate & { instanceId?: string; driver?: ProviderDriver } = {};
  const allowed = new Set(["label", "enabled", "accentColor", "config", "env", "customModels", "revision", ...(create ? ["instanceId", "driver"] : [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key))
    throw new RouteError(400, `Unsupported native Agent setting: ${key}`);
  for (const key of ["label", "accentColor"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") throw new RouteError(400, `${key} must be a string.`);
      result[key] = body[key];
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new RouteError(400, "enabled must be a boolean.");
    result.enabled = body.enabled;
  }
  if (body.config !== undefined) {
    if (!body.config || typeof body.config !== "object" || Array.isArray(body.config))
      throw new RouteError(400, "config must be an object.");
    result.config = {};
    for (const [key, value] of Object.entries(body.config)) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean"
        && !(Array.isArray(value) && value.every(entry => typeof entry === "string")))
        throw new RouteError(400, `Invalid configuration value: ${key}`);
      result.config[key] = value as string | number | boolean | string[] | null;
    }
  }
  if (body.env !== undefined) {
    if (!body.env || typeof body.env !== "object" || Array.isArray(body.env))
      throw new RouteError(400, "env must be an object.");
    result.env = {};
    for (const [key, value] of Object.entries(body.env)) {
      if (typeof value !== "string" && value !== null)
        throw new RouteError(400, "env values must be strings or null for removal.");
      result.env[key] = value;
    }
  }
  if (body.customModels !== undefined) {
    if (!Array.isArray(body.customModels) || body.customModels.length > 100)
      throw new RouteError(400, "customModels must be an array with at most 100 entries.");
    result.customModels = body.customModels.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new RouteError(400, "Each custom model requires an ID and label.");
      const model = value as Record<string, unknown>;
      if (typeof model.id !== "string" || typeof model.label !== "string" || Object.keys(model).some((key) => key !== "id" && key !== "label"))
        throw new RouteError(400, "Custom models accept ID and label only; capabilities are server-owned.");
      return { id: model.id, label: model.label };
    });
  }
  if (create) {
    if (
      !getNativeProviderAdapter(String(body.driver)) ||
      typeof body.label !== "string"
    )
      throw new RouteError(400, "driver and label are required.");
    if (body.instanceId !== undefined && typeof body.instanceId !== "string")
      throw new RouteError(400, "instanceId must be a string.");
    return {
      ...result,
      driver: body.driver as ProviderDriver,
      label: body.label,
      ...(typeof body.instanceId === "string" ? { instanceId: body.instanceId } : {}),
    };
  }
  if (body.driver !== undefined || body.instanceId !== undefined)
    throw new RouteError(400, "Provider driver and instanceId cannot be changed.");
  return result;
}

providerRoutes.post("/providers", async (c) => {
  try {
    const body = await readJsonObject(c.req.raw);
    let instance;
    try {
      instance = createProviderInstance(instanceInput(body, true));
    } catch (error) {
      throw new RouteError(
        400,
        error instanceof Error ? error.message : "Invalid provider configuration.",
      );
    }
    return c.json(await probeProviderInstance(instance.instanceId), 201);
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.put("/providers/:instanceId", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    const body = await readJsonObject(c.req.raw);
    if (!Number.isInteger(body.revision) || Number(body.revision) < 1)
      throw new RouteError(400, "A valid configuration revision is required.");
    const input = instanceInput(body, false);
    try {
      updateProviderInstance(
        instanceId,
        input,
        typeof body.revision === "number" ? body.revision : undefined,
      );
    } catch (error) {
      const conflict =
        error && typeof error === "object" && "status" in error && error.status === 409;
      throw new RouteError(
        conflict ? 409 : 400,
        error instanceof Error ? error.message : "Invalid provider configuration.",
      );
    }
    resetAuthState(instanceId);
    return c.json(await probeProviderInstance(instanceId));
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.delete("/providers/:instanceId", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    resetAuthState(instanceId);
    deleteProviderInstance(instanceId);
    return c.json({ ok: true });
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.post("/providers/:instanceId/test", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    await readOptionalJsonObject(c.req.raw);
    return c.json(await checkProviderConnection(instanceId));
  } catch (error) {
    return respondError(c, error);
  }
});


providerRoutes.get("/providers/:instanceId/auth", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    const state: ProviderAuthState = await getAuthState(instanceId);
    return c.json(state);
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.post("/providers/:instanceId/auth/start", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    const body = await readOptionalJsonObject(c.req.raw);
    if (body.methodId !== undefined && typeof body.methodId !== "string")
      throw new RouteError(400, "methodId must be a string.");
    let values: Record<string, string> | undefined;
    if (body.values !== undefined) {
      if (!body.values || typeof body.values !== "object" || Array.isArray(body.values))
        throw new RouteError(400, "values must be an object.");
      values = {};
      for (const [name, value] of Object.entries(body.values)) {
        if (typeof value !== "string" || value.length > 8192 || name.length > 100)
          throw new RouteError(400, "Invalid native authentication value.");
        values[name] = value;
      }
    }
    const state = await startProviderAuth(instanceId, {
      ...(typeof body.methodId === "string" ? { methodId: body.methodId } : {}), ...(values ? { values } : {}),
    });
    return c.json(state);
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.post("/providers/:instanceId/auth/input", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    const body = await readJsonObject(c.req.raw);
    const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
    const input = typeof body.input === "string" ? body.input : "";
    if (!flowId) throw new RouteError(400, "flowId is required.");
    if (typeof body.input !== "string") throw new RouteError(400, "input must be a string.");
    if (input.length > 4096) throw new RouteError(400, "input is too long.");
    const current = await getAuthState(instanceId);
    if (!current.flowId || current.flowId !== flowId) {
      throw new RouteError(404, "No matching authentication flow.");
    }
    if (!["starting", "waiting", "verifying"].includes(current.phase)) {
      throw new RouteError(409, "This authentication flow is no longer accepting input.");
    }

    return c.json(writeAuthInput(instanceId, flowId, input));
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.post("/providers/:instanceId/auth/cancel", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    const body = await readJsonObject(c.req.raw);
    const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
    if (!flowId) throw new RouteError(400, "flowId is required.");

    const current = await getAuthState(instanceId);
    if (!current.flowId || current.flowId !== flowId) {
      throw new RouteError(404, "No matching authentication flow.");
    }

    const state = await cancelProviderAuth(instanceId, flowId);
    return c.json(state);
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.get("/providers/:instanceId/auth/stream", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
  } catch (error) {
    return respondError(c, error);
  }

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const sendEvent = (event: ProviderAuthStreamEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      heartbeat.unref();

      try {
        let emittedOutput = "";
        for await (const state of subscribeAuth(instanceId, signal)) {
          if (state.output !== emittedOutput) {
            const delta = state.output.startsWith(emittedOutput)
              ? state.output.slice(emittedOutput.length)
              : state.output;
            if (delta) sendEvent({ type: "output", output: delta });
            emittedOutput = state.output;
          }
          sendEvent({ type: "state", state });
          if (closed) break;
        }
      } catch (error) {
        sendEvent({
          type: "error",
          message: sanitizeErrorText(
            error instanceof Error ? error.message : "Authentication stream failed.",
          ),
        });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

providerRoutes.post("/providers/:instanceId/logout", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    return c.json(await logoutProvider(instanceId));
  } catch (error) {
    return respondError(c, error);
  }
});

providerRoutes.post("/providers/:instanceId/prepare", async (c) => {
  const instanceId = c.req.param("instanceId");
  try {
    requireDefinition(instanceId);
    await readOptionalJsonObject(c.req.raw);
    const instance = getStoredInstance(instanceId)!;
    const adapter = getNativeProviderAdapter(instance.driver)!;
    if (!instance.enabled) throw new RouteError(409, "Agent instance is disabled.");
    if (!adapter.prepare) throw new RouteError(409, "This Agent has no native preparation action.");
    const result = await adapter.prepare(providerContext(instance), AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(300_000)]));
    updateProviderInstance(instanceId, {}, instance.revision);
    resetAuthState(instanceId);
    return c.json(result);
  } catch (error) { return respondError(c, error); }
});
