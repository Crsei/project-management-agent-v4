// Loaded by Pi only for an active Chat generation. The URL is a local correlation
// endpoint; PM request credentials remain in the Agent server process.
type PiToolHost = { registerTool(tool: { name: string; label: string; description: string; parameters: object; execute(id: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> }): void };
type TypeFactory = Record<string, (...args: unknown[]) => object>;
function toTypeBox(schema: Record<string, unknown>, type: TypeFactory): object {
  const options = { ...schema };
  for (const key of ["type", "properties", "required", "items", "anyOf", "oneOf", "enum", "const", "$schema"]) delete options[key];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return type.Union!(alternatives.map((item) => toTypeBox(item as Record<string, unknown>, type)), options);
  if (Array.isArray(schema.enum)) return type.Union!(schema.enum.map((item) => type.Literal!(item)), options);
  if ("const" in schema) return type.Literal!(schema.const, options);
  if (schema.type === "object") {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>).map(([key, value]) => {
      const child = toTypeBox(value, type);
      return [key, required.includes(key) ? child : type.Optional!(child)];
    }));
    return type.Object!(properties, options);
  }
  if (schema.type === "array") return type.Array!(toTypeBox(schema.items as Record<string, unknown>, type), options);
  if (schema.type === "string") return type.String!(options);
  if (schema.type === "integer") return type.Integer!(options);
  if (schema.type === "number") return type.Number!(options);
  if (schema.type === "boolean") return type.Boolean!(options);
  if (schema.type === "null") return type.Null!(options);
  return type.Any!(options);
}
export default async function (pi: PiToolHost) {
  const base = process.env.AGENT_PM_TOOL_BRIDGE;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("PM tool bridge unavailable");
  const response = await fetch(`${base}/tools/list`);
  if (!response.ok) throw new Error("PM tool discovery failed");
  // Pi owns the extension loader and supplies this dependency from its own installation.
  const moduleName = "@sinclair/typebox";
  const { Type } = await import(moduleName) as { Type: TypeFactory };
  const registry = await response.json() as { tools: Array<{ name: string; description: string; inputSchema: object }> };
  for (const tool of registry.tools) {
    pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description, parameters: toTypeBox(tool.inputSchema as Record<string, unknown>, Type),
      async execute(id: string, args: unknown) {
        const result = await fetch(`${base}/tools/mcp-call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transportId: "pi-native", requestId: id, name: tool.name, arguments: args }) });
        const record = await result.json();
        if (!result.ok) throw new Error("PM tool transport failed");
        return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
      },
    });
  }
}
