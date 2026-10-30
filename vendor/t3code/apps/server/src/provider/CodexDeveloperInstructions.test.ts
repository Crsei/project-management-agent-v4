import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { buildCodexAdditionalContext, CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "./CodexDeveloperInstructions.ts";

describe("Codex native host context", () => {
  it("keeps source runtime identity within the native per-entry cap", () => {
    const context = buildCodexAdditionalContext({ model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" });
    for (const entry of Object.values(context)) NodeAssert.ok(Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES);
    NodeAssert.match(context.runtime_info!.value, /Codex harness as Custom 🦊 Model with xhigh reasoning effort/);
  });
  it("flattens native metadata and never grants foreign application tools", () => {
    const instructions = buildCodexAdditionalContext({ model: "gpt\n6.1\nsol", reasoningEffort: " high\neffort " });
    NodeAssert.match(instructions.runtime_info!.value, /as gpt 6\.1 sol with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions.runtime_info!.value, /\n/);
    NodeAssert.deepEqual(Object.keys(instructions), ["runtime_info"]);
    NodeAssert.doesNotMatch(JSON.stringify(instructions), /delegate_task|t3_thread|browser|device|link_pull_request/);
  });
});
