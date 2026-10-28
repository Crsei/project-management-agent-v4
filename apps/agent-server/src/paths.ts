import path from "node:path";
import { fileURLToPath } from "node:url";

// src/paths.ts and the production dist/index.mjs have the same package depth.
// Neither package-manager cwd nor the caller's shell selects the user project.
export const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function projectDirectory(): string {
  return path.resolve(workspaceRoot, process.env.AGENT_WORKSPACE_PROJECT_ROOT?.trim() || ".");
}

export function dataDirectory(): string {
  return path.resolve(
    workspaceRoot,
    process.env.AGENT_WORKSPACE_DATA_DIR?.trim() || ".local/agent-data",
  );
}

export function webDistDirectory(): string {
  const configured = process.env.AGENT_WORKSPACE_WEB_DIST?.trim();
  return configured
    ? path.resolve(workspaceRoot, configured)
    : fileURLToPath(new URL("../../agent-web/dist/", import.meta.url));
}
