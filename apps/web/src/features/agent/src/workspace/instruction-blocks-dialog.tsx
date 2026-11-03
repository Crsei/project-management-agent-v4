import { useState } from "react";
import type { RemoteSettings } from "@agent-workspace/contracts/chat";
import { useVoiceSettings } from "@agent/hooks/use-chat-settings";
import { Button } from "@agent/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@agent/components/ui/dialog";
import { useAgentText } from "../i18n";
import { WorkspaceProvider, useWorkspace } from "./provider";
import { ResourceSyncStatus } from "./resource-status";
import { SkillsPanel } from "./skills-panel";
import { AgentsPanel } from "./agents-panel";

function InstructionBlocks({ disabled }: { disabled: boolean }) {
  const t = useAgentText();
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const show = (value: boolean) => { setOpen(value); workspace.setPanel(value ? "skills" : null); };
  return <>
    <button type="button" className="px-1.5 text-xs text-muted-foreground" disabled={disabled} onClick={() => show(true)}>{t("用户指令块", "User instructions")}</button>
    <Dialog open={open} onOpenChange={show}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("保存的用户指令块（不是原生 Skills）", "Saved user instructions (not native Skills)")}</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">{t("此处保留原有会话指令块及 Agent 引用。不会安装、写入或冒充 Provider 原生 SKILL.md。", "This preserves existing session instruction blocks and Agent references. It never installs, writes or impersonates native provider SKILL.md files.")}</p>
      <ResourceSyncStatus />
      {(workspace.storageError || workspace.actionError) && <p role="alert">{workspace.storageError ?? workspace.actionError}</p>}
      <nav className="flex gap-2"><Button size="sm" variant={workspace.panel === "agents" ? "outline" : "default"} onClick={() => workspace.setPanel("skills")}>{t("指令块", "Instruction blocks")}</Button><Button size="sm" variant={workspace.panel === "agents" ? "default" : "outline"} onClick={() => workspace.setPanel("agents")}>{t("Agent 引用", "Agent references")}</Button></nav>
      {workspace.ready ? workspace.panel === "agents" ? <AgentsPanel /> : <SkillsPanel /> : <p role="status">{t("正在读取原有会话资源…", "Loading existing session resources…")}</p>}
    </DialogContent></Dialog>
  </>;
}
export function InstructionBlocksAction({ settings, disabled }: { settings: RemoteSettings; disabled: boolean }) {
  const voice = useVoiceSettings();
  return <WorkspaceProvider settings={{ ...settings, ...voice }}><InstructionBlocks disabled={disabled} /></WorkspaceProvider>;
}
