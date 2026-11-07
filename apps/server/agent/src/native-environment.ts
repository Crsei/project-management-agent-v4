// Native configuration and credential variables are inherited. Loader injection
// and PM/server-only secrets never enter Provider or interactive terminal children.
export const RESERVED_ENV = /^(?:NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|AGENT_WORKSPACE_.*|AGENT_PM_TOOL_.*|PM_(?:API_URL|SESSION_TOKEN|EMAIL|PASSWORD|ACCESS_FILE|WORKSPACE_ID|AUTOMATION_.*)|DATABASE_URL|T3_MCP_.*|T3_PI_MCP_EXTENSION_PATH)$/i;

export function nativeEnvironment(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result = { ...process.env, ...env };
  for (const key of Object.keys(result)) if (RESERVED_ENV.test(key)) delete result[key];
  return result;
}
