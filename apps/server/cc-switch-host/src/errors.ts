/** Translated behavior from vendor/cc-switch/src-tauri/src/error.rs and host error mapping. */

export class AppError extends Error {
  readonly code: string;
  readonly reason?: string;

  constructor(code: string, message: string, reason?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

export function invalidInput(reason: string): AppError {
  return new AppError("INVALID_INPUT", reason, reason);
}

export function configError(reason = "invalid_native_configuration"): AppError {
  return new AppError("CONFIG", reason, reason);
}

export function conflict(reason: string): AppError {
  return new AppError("CONFLICT", reason, reason);
}

export function databaseError(message: string): AppError {
  return new AppError("DATABASE", message);
}

export function ioError(path: string, error: unknown): AppError {
  return new AppError("IO", `${path}: ${String(error)}`);
}

export function mcpValidation(reason: string): AppError {
  return new AppError("MCP_VALIDATION", reason, reason);
}

/** Only finite host-authored codes cross the private JSON-lines boundary. */
export function publicErrorCode(error: unknown): string {
  if (!(error instanceof AppError)) return "COMMAND_FAILED";
  switch (error.code) {
    case "INVALID_INPUT":
      switch (error.reason) {
        case "stale_import_preview": return "mcp_import_preview_stale";
        case "invalid_import_preview":
        case "invalid_import_selection": return "mcp_import_selection_invalid";
        case "conflicting_import_plan":
        case "missing_import_base_selection":
        case "unrepresentable_import_override": return "mcp_import_conflict";
        case "invalid_override":
        case "invalid_configuration":
        case "invalid_server_id": return "mcp_configuration_incompatible";
        case "unbound_target": return "mcp_target_unbound";
        default: return "COMMAND_FAILED";
      }
    case "MCP_VALIDATION":
      return "mcp_configuration_incompatible";
    default:
      return "COMMAND_FAILED";
  }
}
