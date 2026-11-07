/** Translated from vendor/cc-switch/src-tauri/src/mcp/validation.rs. */
import { mcpValidation } from "../errors.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Allow stdio/http/sse; a missing `type` means stdio. Required transport fields
 * must be present (non-blank).
 */
export function validateServerSpec(spec: unknown): asserts spec is Record<string, unknown> {
  if (!isObject(spec)) throw mcpValidation("MCP server connection definition must be a JSON object");
  const explicit = typeof spec.type === "string" ? spec.type : undefined;
  // A non-string `type` is treated as absent, exactly like the upstream
  // `as_str()` extraction.
  const isStdio = explicit === undefined || explicit === "stdio";
  const isHttp = explicit === "http";
  const isSse = explicit === "sse";
  if (!isStdio && !isHttp && !isSse) {
    throw mcpValidation("MCP server type must be 'stdio', 'http' or 'sse' (or omitted for stdio)");
  }
  if (isStdio) {
    const command = typeof spec.command === "string" ? spec.command : "";
    if (command.trim() === "") throw mcpValidation("stdio MCP server is missing the command field");
  }
  if (isHttp || isSse) {
    const url = typeof spec.url === "string" ? spec.url : "";
    if (url.trim() === "") throw mcpValidation(`${isHttp ? "http" : "sse"} MCP server is missing the url field`);
  }
}

/**
 * Transport type used by write-side projections. A spec without `type` that
 * carries a non-empty `url` and no `command` is HTTP, never stdio.
 */
export function specTransportType(spec: Record<string, unknown>): string {
  const has = (key: string): boolean => {
    const value = spec[key];
    return typeof value === "string" && value.trim() !== "";
  };
  const explicit = typeof spec.type === "string" ? spec.type : undefined;
  if ((explicit === undefined || explicit === "stdio") && !has("command") && has("url")) return "http";
  return explicit ?? "stdio";
}

/** Extract the unified connection spec from an MCP entry object. */
export function extractServerSpec(entry: unknown): Record<string, unknown> {
  if (!isObject(entry)) throw mcpValidation("MCP server entry must be a JSON object");
  const server = entry.server;
  if (server === undefined) throw mcpValidation("MCP server entry is missing the server field");
  if (!isObject(server)) throw mcpValidation("MCP server server field must be a JSON object");
  return server;
}
