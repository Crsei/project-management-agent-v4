import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as engine from "../durable/engine.ts";
import * as store from "../durable/store.ts";
import { DurableError } from "../durable/errors.ts";
import {
  continueChatRecovery,
  getChatRecoveryCandidate,
  listChatGenerations,
} from "../durable/chat-runtime.ts";
import { isObject, text } from "../durable/validation.ts";
import { getStoredInstance } from "../providers/instances.ts";
import { GitHubAdapter } from "./github.ts";
import { serverTimeZone } from "./schedule.ts";
import { AutomationError, AutomationService } from "./service.ts";
import { validateSchedule, validateWatch } from "./validation.ts";

const automationKey = Symbol.for("agent-workspace.automation-service");
const globals = globalThis as typeof globalThis & { [automationKey]?: AutomationService };
function getAutomation(): AutomationService {
  if (!globals[automationKey]) {
    globals[automationKey] = new AutomationService({
      store,
      engine,
      github: new GitHubAdapter(),
      chat: {
        getCandidate: getChatRecoveryCandidate,
        continueRun: continueChatRecovery,
        latestInThread(threadId) {
          const latest = listChatGenerations(threadId)[0];
          return latest ? getChatRecoveryCandidate(latest.id) : null;
        },
      },
      providerIdentity(id) {
        const instance = getStoredInstance(id);
        return instance ? `${id}:${instance.revision}` : null;
      },
    });
  }
  return globals[automationKey];
}

/** One lifecycle-owned service; importing routes never starts its timer. */
export async function startAutomation(): Promise<void> {
  await getAutomation().start();
}
export async function stopAutomation(): Promise<void> {
  await globals[automationKey]?.stop();
}

export const automationRoutes = new Hono();
automationRoutes.use(
  "/automation/*",
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: "请求体不得超过 2 MiB。" }, 413),
  }),
);
automationRoutes.onError((error, c) => {
  if (error instanceof AutomationError)
    return c.json({ error: error.message, code: "automation_request_error" }, error.status);
  if (error instanceof DurableError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof SyntaxError)
    return c.json({ error: "请求体必须为有效 JSON。", code: "invalid_request" }, 400);
  console.error("Automation request failed:", error.name);
  return c.json({ error: "自动化操作失败，未确认执行成功。", code: "automation_failure" }, 500);
});

automationRoutes.get("/automation/schedules", (c) =>
  c.json({ schedules: getAutomation().schedules(), timeZone: serverTimeZone() }),
);
automationRoutes.post("/automation/schedules", async (c) => {
  const input: unknown = await c.req.json();
  validateSchedule(input);
  return c.json({ schedule: getAutomation().saveSchedule(input) }, 201);
});
automationRoutes.put("/automation/schedules/:id", async (c) => {
  const input: unknown = await c.req.json();
  validateSchedule(input);
  return c.json({ schedule: getAutomation().saveSchedule(input, c.req.param("id")) });
});
automationRoutes.delete("/automation/schedules/:id", (c) => {
  getAutomation().deleteSchedule(c.req.param("id"));
  return c.body(null, 204);
});
automationRoutes.post("/automation/schedules/:id/run", async (c) => {
  const raw = await c.req.text();
  const input: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (
    !isObject(input) ||
    Object.keys(input).some((key) => key !== "idempotencyKey") ||
    (input.idempotencyKey !== undefined && !text(input.idempotencyKey, 120, true))
  ) {
    throw new AutomationError("立即执行只接受可选的 idempotencyKey（1–120 字符）。");
  }
  return c.json(
    {
      dispatch: await getAutomation().runSchedule(
        c.req.param("id"),
        input.idempotencyKey as string | undefined,
      ),
    },
    202,
  );
});
automationRoutes.get("/automation/watches", (c) => c.json({ watches: getAutomation().watches() }));
automationRoutes.post("/automation/watches", async (c) => {
  const input: unknown = await c.req.json();
  validateWatch(input);
  return c.json({ watch: getAutomation().saveWatch(input) }, 201);
});
automationRoutes.put("/automation/watches/:id", async (c) => {
  const input: unknown = await c.req.json();
  validateWatch(input);
  return c.json({ watch: getAutomation().saveWatch(input, c.req.param("id")) });
});
automationRoutes.delete("/automation/watches/:id", (c) => {
  getAutomation().deleteWatch(c.req.param("id"));
  return c.body(null, 204);
});
automationRoutes.post("/automation/watches/:id/check", async (c) =>
  c.json({ watch: await getAutomation().checkWatch(c.req.param("id")) }),
);
automationRoutes.get("/automation/recovery", (c) =>
  c.json({ recoveries: getAutomation().recoveries() }),
);
automationRoutes.put("/automation/recovery/:runId", async (c) => {
  const input: unknown = await c.req.json();
  if (!isObject(input) || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean") {
    throw new AutomationError("额度恢复请求必须为 {enabled:boolean}。");
  }
  return c.json({ recovery: getAutomation().setRecovery(c.req.param("runId"), input.enabled) });
});
automationRoutes.get("/automation/dispatches", (c) =>
  c.json({ dispatches: getAutomation().dispatches(c.req.query("sourceId")) }),
);
