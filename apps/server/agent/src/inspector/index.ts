import { Hono } from "hono";
import { filesRoutes } from "./files.ts";
import { gitRoutes } from "./git.ts";
import { terminalRoutes } from "./terminal.ts";
import { mediaRoutes } from "./media.ts";

/**
 * Read-only inspector API. Mounted under `/api`, so the public paths are
 * `/api/inspector/files`, `/api/inspector/file`, `/api/inspector/search`,
 * `/api/inspector/media`, `/api/inspector/git` and `/api/inspector/git/diff`.
 */
export const inspectorRoutes = new Hono()
  .route("/inspector", filesRoutes)
  .route("/inspector", mediaRoutes)
  .route("/inspector", gitRoutes)
  .route("/inspector", terminalRoutes);
