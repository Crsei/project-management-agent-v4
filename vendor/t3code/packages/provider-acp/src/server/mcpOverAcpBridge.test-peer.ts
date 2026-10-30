import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "pm-transport-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "fixture_add", description: "Controlled arithmetic transport probe",
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "fixture_wait") {
    const { promise, resolve } = Promise.withResolvers<void>();
    extra.signal.addEventListener("abort", () => resolve(), { once: true });
    await promise;
    return { isError: true, content: [{ type: "text", text: "Native tool cancelled" }] };
  }
  const { a, b } = request.params.arguments ?? {};
  if (request.params.name !== "fixture_add" || typeof a !== "number" || typeof b !== "number") throw new Error("Unknown controlled tool or invalid operands.");
  return { content: [{ type: "text", text: String(a + b) }] };
});
await server.connect(new StdioServerTransport());
