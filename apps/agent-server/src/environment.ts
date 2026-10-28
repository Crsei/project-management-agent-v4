import { loadEnvFile } from "node:process";
import path from "node:path";
import { workspaceRoot } from "./paths.ts";

try {
  loadEnvFile(path.join(workspaceRoot, ".env.agent"));
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
    throw error;
}
