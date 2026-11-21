import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DurableError } from "../durable/errors.ts";
import {
  evaluationStatus, configureEvaluationPolicy, pauseEvaluationPolicy, deleteEvaluationObservations, expireEvaluationObservations,
  exportEvaluationMetadata, createEvaluationWindow, summarizeEvaluationWindow, recordEvaluationDecision, evaluationDecisions,
} from "./service.ts";

/** Mounted behind the existing Agent accessGuard. No model/PM tool exposes this control plane. */
export const evaluationFeedbackRoutes = new Hono();
evaluationFeedbackRoutes.use("/evaluation/*", bodyLimit({ maxSize: 128 * 1024 }));
evaluationFeedbackRoutes.use("/evaluation/*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
evaluationFeedbackRoutes.onError((error, c) => {
  if (error instanceof DurableError) return c.json({ code: error.code, error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: "invalid_request", error: "Invalid metadata observation request." }, 400);
  return c.json({ code: "evaluation_store_unavailable", error: "Observation storage is unavailable; no deployment or business replay was performed." }, 500);
});
evaluationFeedbackRoutes.get("/evaluation/status", async c => c.json(await evaluationStatus(c.req.raw.headers)));
evaluationFeedbackRoutes.post("/evaluation/policies", async c => c.json(await configureEvaluationPolicy(await c.req.json(), c.req.raw.headers), 201));
evaluationFeedbackRoutes.post("/evaluation/policies/pause", async c => c.json(pauseEvaluationPolicy(await c.req.json())));
evaluationFeedbackRoutes.post("/evaluation/policies/revoke", async c => c.json(pauseEvaluationPolicy(await c.req.json(), true)));
evaluationFeedbackRoutes.post("/evaluation/observations/delete", async c => c.json(deleteEvaluationObservations(await c.req.json())));
evaluationFeedbackRoutes.post("/evaluation/retention", c => c.json(expireEvaluationObservations()));
evaluationFeedbackRoutes.post("/evaluation/export", async c => c.json(await exportEvaluationMetadata(c.req.raw.headers)));
evaluationFeedbackRoutes.post("/evaluation/windows", async c => c.json(await createEvaluationWindow(await c.req.json(), c.req.raw.headers), 201));
evaluationFeedbackRoutes.get("/evaluation/windows/:id", async c => c.json(await summarizeEvaluationWindow(z.uuid().parse(c.req.param("id")), c.req.raw.headers)));
evaluationFeedbackRoutes.post("/evaluation/decisions", async c => c.json(await recordEvaluationDecision(await c.req.json(), c.req.raw.headers), 201));
evaluationFeedbackRoutes.get("/evaluation/decisions", async c => c.json(await evaluationDecisions(c.req.raw.headers)));
