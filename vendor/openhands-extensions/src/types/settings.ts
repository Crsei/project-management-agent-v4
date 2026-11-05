/** Extracted OpenHands Skills presentation types; management authority stays in CC Switch. */
export type SkillType = "repo" | "knowledge" | "agentskills";
export type SkillOrigin = "public" | "user";

export type SkillInfo = {
  name: string;
  type: SkillType;
  source: string | null;
  origin?: SkillOrigin;
  description?: string | null;
  triggers?: string[];
  category?: string | null;
  version?: string;
  license?: string | null;
  compatibility?: string | null;
  metadata?: Record<string, string> | null;
  allowed_tools?: string[] | null;
  is_agentskills_format?: boolean;
  disable_model_invocation?: boolean;
  content?: string;
};
