import React from "react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import type { SkillInfo } from "@pm/openhands-source/types/settings";
import { cn } from "@pm/openhands-source/utils/utils";
import { Copy as CopyIcon, Check as CheckmarkIcon } from "lucide-react";
import { copyText } from "@pm/cc-switch-source/lib/clipboard";
import { toast } from "@pm/cc-switch-source/lib/toast";
import { SkillIconBadge } from "./skill-icon-badge";
import { SkillCardPillRow } from "./skill-card-pill-row";
import { getSkillCardDescription } from "./get-skill-card-description";
import { buildSkillPills } from "./build-skill-pills";
import { isCopyableSkillSource } from "./is-copyable-skill-source";
import {
  extensionModuleCardInteractiveClassName,
  extensionModuleCardSurfaceClassName,
} from "@pm/openhands-source/utils/extension-module-card-classes";

interface SkillCardProps {
  skill: SkillInfo;
  onOpen: () => void;
  action?: React.ReactNode;
  summary?: React.ReactNode;
}

export function SkillCard({
  skill,
  onOpen,
  action,
  summary,
}: SkillCardProps) {
  const { t } = useOpenHandsTranslation();
  const [sourceCopied, setSourceCopied] = React.useState(false);

  const description = getSkillCardDescription(skill);
  const pills = React.useMemo(() => buildSkillPills(skill, t), [skill, t]);
  const showCopySource = isCopyableSkillSource(skill.source);

  const handleCopySource = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!skill.source) {
      return;
    }

    try {
      await copyText(skill.source);
      setSourceCopied(true);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  React.useEffect(() => {
    if (!sourceCopied) {
      return undefined;
    }

    const timeout = setTimeout(() => setSourceCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [sourceCopied]);

  return (
    <div
      data-testid={`skill-card-${skill.name}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className={cn(
        "oh-skill-card flex min-w-0 flex-col gap-3 overflow-hidden p-4",
        extensionModuleCardSurfaceClassName,
        extensionModuleCardInteractiveClassName,
      )}
    >
      <div className="flex items-start gap-3">
        <SkillIconBadge skillName={skill.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <header className="oh-skill-card-heading flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3
                data-testid={`skill-name-${skill.name}`}
                className="oh-skill-card-name break-words text-sm font-semibold text-contrast"
                title={skill.name}
              >
                {skill.name}
              </h3>
              {skill.source ? (
                <div className="mt-0.5 flex min-w-0 items-center gap-1">
                  <p
                    data-testid={`skill-source-${skill.name}`}
                    className="min-w-0 flex-1 truncate text-xs text-tertiary-alt"
                    title={skill.source}
                  >
                    {skill.source}
                  </p>
                  {showCopySource ? (
                    <button
                      type="button"
                      data-testid={`skill-copy-source-${skill.name}`}
                      aria-label={t(
                        sourceCopied
                          ? "BUTTON$COPIED"
                          : "SETTINGS$SKILLS_COPY_PATH",
                      )}
                      disabled={sourceCopied}
                      onClick={handleCopySource}
                      className="shrink-0 cursor-pointer border-0 bg-transparent p-0.5 text-tertiary-alt hover:text-contrast disabled:cursor-default [&_path]:fill-current"
                    >
                      {sourceCopied ? (
                        <CheckmarkIcon width={12} height={12} />
                      ) : (
                        <CopyIcon width={12} height={12} />
                      )}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {action ? <div className="oh-skill-card-actions" onClick={(event) => event.stopPropagation()}>{action}</div> : null}
          </header>

          {description ? (
            <div
              data-testid={`skill-description-${skill.name}`}
              className="min-w-0"
            >
              <p className="line-clamp-2 break-words text-xs leading-relaxed text-tertiary-light">
                {description}
              </p>
            </div>
          ) : null}
          {summary ? <div className="text-xs text-tertiary-light">{summary}</div> : null}

          {!summary && pills.length > 0 ? (
            <SkillCardPillRow
              pills={pills}
              testId={`skill-triggers-${skill.name}`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
