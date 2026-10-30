import "../src/environment.ts";

process.env.PORT = process.env.AGENT_WORKSPACE_API_PORT ?? "4325";
process.env.AGENT_WORKSPACE_API_ONLY = "1";
