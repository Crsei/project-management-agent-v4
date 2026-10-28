import { Hono } from "hono";
import { z } from "zod";
import { ChatDefaultsError, getChatDefaults, saveChatDefaults } from "./chat-defaults.ts";

export const settingsRoutes = new Hono();
settingsRoutes.onError((error, c) => {
  if (error instanceof ChatDefaultsError)
    return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: "默认模型设置格式无效。", code: "invalid_request" }, 400);
  console.error("Chat defaults request failed:", error instanceof Error ? error.name : "unknown");
  return c.json({ error: "无法读取或保存默认模型，请检查本机 Agent 存储。", code: "settings_error" }, 500);
});
settingsRoutes.get("/settings/chat-defaults", async (c) => c.json(await getChatDefaults()));
settingsRoutes.put("/settings/chat-defaults", async (c) => c.json(await saveChatDefaults(await c.req.json())));
