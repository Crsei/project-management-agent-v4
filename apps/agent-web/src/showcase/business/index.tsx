import { lazy } from "react";
import type { ShowcasePage } from "../types";
import { remainingShowcases } from "./remaining-catalog";
export { RemainingSession as Provider } from "./remaining-session";

const components = {
  "composer-3": lazy(() =>
    import("./remaining/composer-3-explorer").then((module) => ({
      default: module.Composer3RemainingExplorer,
    })),
  ),
  "composer-4": lazy(() =>
    import("./remaining/composer-4-explorer").then((module) => ({
      default: module.Composer4RemainingExplorer,
    })),
  ),
  "composer-5": lazy(() =>
    import("./remaining/composer-5-explorer").then((module) => ({
      default: module.Composer5RemainingExplorer,
    })),
  ),
  "composer-6": lazy(() =>
    import("./remaining/composer-6-explorer").then((module) => ({
      default: module.Composer6RemainingExplorer,
    })),
  ),
  "composer-7": lazy(() =>
    import("./remaining/composer-7-explorer").then((module) => ({
      default: module.Composer7RemainingExplorer,
    })),
  ),
  "workflow-1": lazy(() =>
    import("./remaining/workflow-1-explorer").then((module) => ({
      default: module.Workflow1RemainingExplorer,
    })),
  ),
  "workflow-2": lazy(() =>
    import("./remaining/workflow-2-explorer").then((module) => ({
      default: module.Workflow2RemainingExplorer,
    })),
  ),
  "workflow-3": lazy(() =>
    import("./remaining/workflow-3-explorer").then((module) => ({
      default: module.Workflow3RemainingExplorer,
    })),
  ),
  "automation-1": lazy(() =>
    import("./remaining/automation-1-explorer").then((module) => ({
      default: module.Automation1RemainingExplorer,
    })),
  ),
  "automation-run-history": lazy(() =>
    import("./remaining/automation-run-history-explorer").then((module) => ({
      default: module.AutomationRunHistoryRemainingExplorer,
    })),
  ),
  "pdf-evidence-chat": lazy(() =>
    import("./remaining/pdf-evidence-chat-explorer").then((module) => ({
      default: module.PdfEvidenceChatRemainingExplorer,
    })),
  ),
  "document-writing-workspace": lazy(() =>
    import("./remaining/document-writing-workspace-explorer").then((module) => ({
      default: module.DocumentWritingWorkspaceRemainingExplorer,
    })),
  ),
  "artifact-version-review": lazy(() =>
    import("./remaining/artifact-version-review-explorer").then((module) => ({
      default: module.ArtifactVersionReviewRemainingExplorer,
    })),
  ),
  "deliverable-file-cabinet": lazy(() =>
    import("./remaining/deliverable-file-cabinet-explorer").then((module) => ({
      default: module.DeliverableFileCabinetRemainingExplorer,
    })),
  ),
  "document-comparison": lazy(() =>
    import("./remaining/document-comparison-explorer").then((module) => ({
      default: module.DocumentComparisonRemainingExplorer,
    })),
  ),
  "knowledge-base": lazy(() =>
    import("./remaining/knowledge-base-explorer").then((module) => ({
      default: module.KnowledgeBaseRemainingExplorer,
    })),
  ),
  "research-brief-builder": lazy(() =>
    import("./remaining/research-brief-builder-explorer").then((module) => ({
      default: module.ResearchBriefBuilderRemainingExplorer,
    })),
  ),
  "evidence-comparison-matrix": lazy(() =>
    import("./remaining/evidence-comparison-matrix-explorer").then((module) => ({
      default: module.EvidenceComparisonMatrixRemainingExplorer,
    })),
  ),
  "visual-inspection": lazy(() =>
    import("./remaining/visual-inspection-explorer").then((module) => ({
      default: module.VisualInspectionRemainingExplorer,
    })),
  ),
  "embedded-commerce-copilot": lazy(() =>
    import("./remaining/embedded-commerce-copilot-explorer").then((module) => ({
      default: module.EmbeddedCommerceCopilotRemainingExplorer,
    })),
  ),
  "mobile-screen-workspace": lazy(() =>
    import("./remaining/mobile-screen-workspace-explorer").then((module) => ({
      default: module.MobileScreenWorkspaceRemainingExplorer,
    })),
  ),
  "creative-canvas": lazy(() =>
    import("./remaining/creative-canvas-explorer").then((module) => ({
      default: module.CreativeCanvasRemainingExplorer,
    })),
  ),
  "generation-pipeline": lazy(() =>
    import("./remaining/generation-pipeline-explorer").then((module) => ({
      default: module.GenerationPipelineRemainingExplorer,
    })),
  ),
  "skill-library": lazy(() =>
    import("./remaining/skill-library-explorer").then((module) => ({
      default: module.SkillLibraryRemainingExplorer,
    })),
  ),
  "skills-manager": lazy(() =>
    import("./remaining/skills-manager-explorer").then((module) => ({
      default: module.SkillsManagerRemainingExplorer,
    })),
  ),
  "agent-studio-builder": lazy(() =>
    import("./remaining/agent-studio-builder-explorer").then((module) => ({
      default: module.AgentStudioBuilderRemainingExplorer,
    })),
  ),
  "agent-studio-integrations": lazy(() =>
    import("./remaining/agent-studio-integrations-explorer").then((module) => ({
      default: module.AgentStudioIntegrationsRemainingExplorer,
    })),
  ),
  "agent-studio-skills": lazy(() =>
    import("./remaining/agent-studio-skills-explorer").then((module) => ({
      default: module.AgentStudioSkillsRemainingExplorer,
    })),
  ),
  "agent-activity": lazy(() =>
    import("./remaining/agent-activity-explorer").then((module) => ({
      default: module.AgentActivityRemainingExplorer,
    })),
  ),
  "agent-factory-1": lazy(() =>
    import("./remaining/agent-factory-1-explorer").then((module) => ({
      default: module.AgentFactory1RemainingExplorer,
    })),
  ),
  "agent-traces": lazy(() =>
    import("./remaining/agent-traces-explorer").then((module) => ({
      default: module.AgentTracesRemainingExplorer,
    })),
  ),
  "agent-detail": lazy(() =>
    import("./remaining/agent-detail-explorer").then((module) => ({
      default: module.AgentDetailRemainingExplorer,
    })),
  ),
  "agent-configuration": lazy(() =>
    import("./remaining/agent-configuration-explorer").then((module) => ({
      default: module.AgentConfigurationRemainingExplorer,
    })),
  ),
  "canvas-workbench": lazy(() =>
    import("./remaining/canvas-workbench-explorer").then((module) => ({
      default: module.CanvasWorkbenchRemainingExplorer,
    })),
  ),
  "mixed-agent-canvas": lazy(() =>
    import("./remaining/mixed-agent-canvas-explorer").then((module) => ({
      default: module.MixedAgentCanvasRemainingExplorer,
    })),
  ),
};

export const pages: ShowcasePage[] = remainingShowcases.map((page) => ({
  id: page.href.slice("/showcase/".length),
  group: page.group,
  title: page.title,
  description: page.description,
  scenarios: page.scenarios,
  deferred: page.deferred,
  Component: components[page.id],
}));
