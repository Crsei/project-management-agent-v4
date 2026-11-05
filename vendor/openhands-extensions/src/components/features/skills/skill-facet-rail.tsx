import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { cn } from "@pm/openhands-source/utils/utils";
import { SkillFacetRow } from "./skill-facet-row";
import type { SkillFacetGroup, SkillFacetGroupId } from "./skill-filter";

interface SkillFacetRailProps {
  groups: SkillFacetGroup[];
  onToggle: (groupId: SkillFacetGroupId, value: string) => void;
  className?: string;
}


export function SkillFacetRail({
  groups,
  onToggle,
  className,
}: SkillFacetRailProps) {
  const { t } = useOpenHandsTranslation();

  if (groups.length === 0) return null;

  return (
    <div
      data-testid="skill-facet-rail"
      className={cn("flex min-w-0 flex-col gap-5", className)}
    >
      {groups.map((group) => {
        const titleId = `skill-facet-group-${group.id}-title`;
        return (
          <div
            key={group.id}
            data-testid={`skill-facet-group-${group.id}`}
            role="group"
            aria-labelledby={titleId}
            className="flex flex-col gap-1.5"
          >
            <span
              id={titleId}
              className="px-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary-alt"
            >
              {t(group.labelKey)}
            </span>
            {group.rows.map((row) => (
              <SkillFacetRow
                key={row.value}
                testId={`skill-facet-${group.id}-${row.value}`}
                labelKey={row.labelKey}
                count={row.count}
                checked={row.checked}
                disabled={row.disabled}
                onToggle={() => onToggle(group.id, row.value)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
