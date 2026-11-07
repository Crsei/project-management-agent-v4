/**
 * Adapter registry translated from vendor/cc-switch/src-tauri/src/mcp/mod.rs.
 *
 * Each module exposes an `AppAdapter` either as `adapter` or as a
 * `<app>Adapter` alias; both spellings are accepted while the adapters settle.
 */
import { configError } from "../../errors.ts";
import { APP_IDS, type AppId } from "../../types.ts";
import type { AppAdapter } from "../adapter.ts";
import * as claudeModule from "./claude.ts";
import * as codexModule from "./codex.ts";
import * as geminiModule from "./gemini.ts";
import * as grokbuildModule from "./grokbuild.ts";
import * as opencodeModule from "./opencode.ts";
import * as hermesModule from "./hermes.ts";
import * as piModule from "./pi.ts";
import * as mcodeModule from "./mcode.ts";
import * as kimiModule from "./kimi.ts";
import * as dshModule from "./dsh.ts";
import * as agyModule from "./agy.ts";
import * as ompModule from "./omp.ts";

const MODULES: Record<AppId, Record<string, unknown>> = {
  claude: claudeModule,
  codex: codexModule,
  gemini: geminiModule,
  grokbuild: grokbuildModule,
  opencode: opencodeModule,
  hermes: hermesModule,
  pi: piModule,
  mcode: mcodeModule,
  kimi: kimiModule,
  dsh: dshModule,
  agy: agyModule,
  omp: ompModule,
};

function isAdapter(value: unknown, app: AppId): value is AppAdapter {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AppAdapter>;
  return candidate.app === app
    && typeof candidate.read === "function"
    && typeof candidate.syncAll === "function"
    && typeof candidate.syncOne === "function"
    && typeof candidate.disable === "function"
    && typeof candidate.remove === "function"
    && typeof candidate.project === "function"
    && typeof candidate.matches === "function";
}

function adapterFor(app: AppId): AppAdapter {
  const module = MODULES[app];
  const candidate = module[`${app}Adapter`] ?? module.adapter;
  if (!isAdapter(candidate, app)) throw configError(`Missing native adapter for ${app}`);
  return candidate;
}

export const ADAPTERS: Record<AppId, AppAdapter> = Object.fromEntries(
  APP_IDS.map((app) => [app, adapterFor(app)]),
) as Record<AppId, AppAdapter>;
