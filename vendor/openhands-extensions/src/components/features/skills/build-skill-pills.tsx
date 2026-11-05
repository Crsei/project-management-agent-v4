import React from "react";
import type { TFunction } from "i18next";
import type { SkillInfo } from "@pm/openhands-source/types/settings";
import { cn } from "@pm/openhands-source/utils/utils";
import { SkillTypeBadge } from "./skill-type-badge";
import { SKILL_CARD_PILL_CLASS, type SkillCardPill } from "./skill-card-pill-row";

type SkillPillVariant = "card" | "detail";
interface BuildSkillPillsOptions {
  variant?: SkillPillVariant;
  testIdPrefix?: string;
}

/** Source metadata only: repository skills are not the OpenHands bundled catalog. */
export function buildSkillPills(
  skill: SkillInfo,
  translate: TFunction,
  { variant = "card", testIdPrefix }: BuildSkillPillsOptions = {},
): SkillCardPill[] {
  const pills: SkillCardPill[] = [{
    id: `type-${skill.type}`,
    node: <SkillTypeBadge type={skill.type} />,
  }];
  const add = (id: string, value: React.ReactNode, mono = false) => {
    pills.push({ id, node: <span
      data-testid={testIdPrefix ? `${testIdPrefix}-${skill.name}-${id}` : undefined}
      className={cn(SKILL_CARD_PILL_CLASS, mono && "font-mono")}
    >{value}</span> });
  };
  if (skill.version) add("version", translate("SETTINGS$SKILLS_VERSION", { version: skill.version }));
  if (variant === "detail" && skill.license) add("license", skill.license);
  if (variant === "detail" && skill.compatibility) add("compatibility", skill.compatibility);
  if (skill.disable_model_invocation) add("disable-model-invocation", translate("SETTINGS$SKILLS_DISABLE_MODEL_INVOCATION"));
  if (variant === "detail") {
    for (const tool of skill.allowed_tools ?? []) add(`tool-${tool}`, tool, true);
    for (const [key, value] of Object.entries(skill.metadata ?? {})) add(`metadata-${key}`, `${key}: ${value}`, true);
  }
  for (const trigger of skill.triggers ?? []) add(`trigger-${trigger}`, trigger);
  return pills;
}
