import type { McpServer } from "../types";
import { isWindows } from "../lib/platform";
import { createMcpPresets } from "@agent-workspace/contracts/mcp-presets";

export type McpPreset = Omit<McpServer, "enabled" | "description">;

// Preserve the browser platform selection and public UI exports while sharing
// the exact template data with the Agent host's server-platform catalog.
export const mcpPresets: McpPreset[] = createMcpPresets(isWindows());

// 获取带国际化描述的预设
export const getMcpPresetWithDescription = (
  preset: McpPreset,
  t: (key: string) => string,
): McpServer => {
  const descriptionKey = `mcp.presets.${preset.id}.description`;
  return {
    ...preset,
    description: t(descriptionKey),
  } as McpServer;
};

export default mcpPresets;
