import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SDKCustomTool, AgentOptions } from "@cursor/sdk";
import { z } from "zod";
export interface CursorHostToolConnection { readonly tools: Record<string, SDKCustomTool>; readonly close: () => Promise<void> }

/** Generation-owned transport admission, not authorization of any PM business action. */
export async function connectCursorHostTools(options: AgentOptions, currentAgentId: () => string | undefined): Promise<CursorHostToolConnection> {
  const clients: Client[] = [];
  const tools: Record<string, SDKCustomTool> = {};
  const close = async () => { await Promise.all(clients.map(client => client.close())); };
  try {
    for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
      if (name !== "pm_tools" || server.type !== "stdio") throw new Error("Unbound Cursor native MCP server.");
      const client = new Client({ name: "pm-cursor-generation", version: "1" }, { capabilities: {} });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }), stderr: "ignore" }));
      let cursor: string | undefined;
      do {
        const catalog = await client.listTools(cursor ? { cursor } : {});
        for (const tool of catalog.tools) {
          if (!/^pm_[a-z_]+$/.test(tool.name)) throw new Error("Cursor PM transport returned an unrecognized tool.");
          if (tools[tool.name]) throw new Error("Cursor PM transport returned duplicate tools.");
          tools[tool.name] = {
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: z.record(z.string(), z.json()).parse(tool.inputSchema),
            async execute(args, context) {
              if (!currentAgentId() || context.sessionId !== currentAgentId()) throw new Error("Cursor PM transport belongs to another native session.");
              return JSON.stringify(await client.callTool({ name: tool.name, arguments: args }));
            },
          };
        }
        cursor = catalog.nextCursor;
      } while (cursor);
    }
    if (clients.length && !Object.keys(tools).length) throw new Error("Cursor PM transport returned no tools.");
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
