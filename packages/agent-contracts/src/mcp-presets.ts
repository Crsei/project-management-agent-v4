// Adapted from farion1231/cc-switch src/config/mcpPresets.ts at
// 7afceec14b977ecc2f4373e8ffb40e7223b435ac (4.0.25).
// MIT, Copyright (c) 2025 Jason Young; see vendor/cc-switch/LICENSE.
// One canonical template catalog for the retained UI and the Agent API. Listing
// a template never installs, loads, probes or grants execution of its server.
export type McpPreset = {
  id: string;
  name: string;
  tags: string[];
  server: { type: 'stdio'; command: string; args: string[] };
  homepage: string;
  docs: string;
};

function npxCommand(windows: boolean, packageName: string): { command: string; args: string[] } {
  return windows ? { command: 'cmd', args: ['/c', 'npx', '-y', packageName] } : { command: 'npx', args: ['-y', packageName] };
}

/** The caller supplies the actual execution platform, not a remote client's OS. */
export function createMcpPresets(windows: boolean): McpPreset[] {
  return [
    {
      id: 'fetch', name: 'mcp-server-fetch', tags: ['stdio', 'http', 'web'],
      server: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    },
    {
      id: 'time', name: 'mcp-server-time', tags: ['stdio', 'time', 'utility'],
      // The official time server is published on PyPI, not npm.
      server: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    },
    {
      id: 'memory', name: '@modelcontextprotocol/server-memory', tags: ['stdio', 'memory', 'graph'],
      server: { type: 'stdio', ...npxCommand(windows, '@modelcontextprotocol/server-memory') },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    },
    {
      id: 'sequential-thinking', name: '@modelcontextprotocol/server-sequential-thinking', tags: ['stdio', 'thinking', 'reasoning'],
      server: { type: 'stdio', ...npxCommand(windows, '@modelcontextprotocol/server-sequential-thinking') },
      homepage: 'https://github.com/modelcontextprotocol/servers',
      docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    },
    {
      id: 'context7', name: '@upstash/context7-mcp', tags: ['stdio', 'docs', 'search'],
      server: { type: 'stdio', ...npxCommand(windows, '@upstash/context7-mcp') },
      homepage: 'https://context7.com', docs: 'https://github.com/upstash/context7/blob/master/README.md',
    },
  ];
}
