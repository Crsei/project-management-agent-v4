import type { ExtensionMcpDefinition, ExtensionMcpManagement } from "@agent-workspace/contracts/extensions";
import { McpFormModal } from "@pm/cc-switch-ui";
import { webPlatform } from "@pm/openhands-source/web/bridge";
import { managementToSourceServers } from "@pm/openhands-source/web/mcp/definition-adapter";

interface CustomServerEditorProps {
  definition?: ExtensionMcpDefinition;
  management: ExtensionMcpManagement;
  onClose: () => void;
  onInteractionBlockedChange?: (blocked: boolean) => void;
}

/** The original CC Switch form retains transport validation, presets, paste
 * recognition, batch handling, metadata and masked-secret round trips. Library
 * mode writes definitions only; it cannot replace assignments or overrides. */
export function CustomServerEditor({ definition, management, onClose, onInteractionBlockedChange }: CustomServerEditorProps) {
  const servers = managementToSourceServers(management);
  return <McpFormModal
    definitionOnly
    editingId={definition?.id}
    initialData={definition ? servers[definition.id] : undefined}
    existingServers={servers}
    visibleAppIds={[]}
    allowedTransports={webPlatform().context.kind === "project" ? ["http"] : undefined}
    onSave={onClose}
    onClose={onClose}
    onInteractionBlockedChange={onInteractionBlockedChange}
  />;
}
