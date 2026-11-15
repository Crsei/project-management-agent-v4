import { Hono } from "hono";
import { z } from "zod";
import { inboxQuerySchema } from "@agent-workspace/contracts/collaboration";
import { DurableError } from "../durable/errors.ts";
import { listCollaborationInbox } from "./inbox.ts";

export const collaborationInboxRoutes = new Hono();
collaborationInboxRoutes.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: "Invalid Inbox query", code: "invalid_inbox_query" }, 400);
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  const status = "status" in error ? Number(error.status) : 0;
  if (status === 401 || status === 403) return c.json({ error: "Inbox is not currently accessible.", code: "inbox_access_denied" }, status);
  return c.json({ error: "Inbox could not be read safely.", code: "inbox_unavailable" }, 503);
});
collaborationInboxRoutes.get("/collaboration/inbox", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const query = inboxQuerySchema.parse(c.req.query());
  return c.json({ items: await listCollaborationInbox(query, c.req.raw.headers) });
});
