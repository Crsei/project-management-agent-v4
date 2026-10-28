import {
  Bot,
  CalendarClock,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  ListChecks,
  SquareTerminal,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { WorkspacePanel } from "@agent-workspace/contracts/workspace";

export type PanelGroup = "session" | "inspector";

export type PanelMeta = {
  id: WorkspacePanel;
  label: string;
  group: PanelGroup;
  icon: LucideIcon;
};

/** Navigation order shared by the left sidebar and the right inspector rail. */
export const PANELS: PanelMeta[] = [
  { id: "workflows", label: "工作流", group: "session", icon: Workflow },
  { id: "agents", label: "Agent", group: "session", icon: Bot },
  { id: "documents", label: "文档", group: "session", icon: FileText },
  { id: "skills", label: "技能", group: "session", icon: WandSparkles },
  { id: "runs", label: "运行记录", group: "session", icon: ListChecks },
  { id: "automation", label: "自动化", group: "session", icon: CalendarClock },
  { id: "files", label: "文件", group: "inspector", icon: FolderTree },
  { id: "git", label: "Git", group: "inspector", icon: GitBranch },
  { id: "terminal", label: "终端", group: "inspector", icon: SquareTerminal },
  { id: "browser", label: "浏览器", group: "inspector", icon: Globe },
];
