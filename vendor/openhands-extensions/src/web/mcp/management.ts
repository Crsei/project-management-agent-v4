/** Public safe reason codes from the Rust adapters / host boundary. These are
 * presentation explanations, not duplicate compatibility or projection rules. */
const REASONS: Record<string, true> = {
  invalid_configuration: true,
  unsupported_transport: true,
  invalid_server_id: true,
  unsupported_app: true,
  native_read_failed: true,
  invalid_native_configuration: true,
  native_profiles_conflict: true,
  native_not_initialized: true,
  native_configuration_differs: true,
  native_comparison_failed: true,
  server_configuration_differs: true,
  same_id_native_configuration_differs: true,
  invalid_import_entry: true,
};

export function mcpReasonText(reason: string, t: (key: string) => string): string {
  return Object.hasOwn(REASONS, reason) ? t(`MCP_PM$REASON_${reason}`) : reason;
}
