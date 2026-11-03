import { loadEnvFile } from "node:process";
import path from "node:path";
import { workspaceRoot } from "./paths.ts";

// The desktop supplies an isolated, role-specific environment. Loading a checkout
// file here would import the developer instance's credentials into that instance.
if (process.env.PM_DESKTOP_MANAGED !== "1") {
  try {
    loadEnvFile(path.join(workspaceRoot, ".env.agent"));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
}
