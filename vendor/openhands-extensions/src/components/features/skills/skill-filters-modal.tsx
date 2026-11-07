import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import { BrandButton } from "@pm/openhands-source/components/features/settings/brand-button";
import { Dialog, DialogContent, DialogTitle } from "@pm/cc-switch-ui";
import { SkillFacetRail } from "./skill-facet-rail";
import type { SkillFacetGroup, SkillFacetGroupId } from "./skill-filter";

interface SkillFiltersModalProps {
  groups: SkillFacetGroup[];
  activeCount: number;
  onToggle: (groupId: SkillFacetGroupId, value: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}

export function SkillFiltersModal({ groups, activeCount, onToggle, onClearAll, onClose }: SkillFiltersModalProps) {
  const { t } = useOpenHandsTranslation();
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-testid="skill-filters-modal" aria-describedby={undefined} className="oh-skill-filters">
      <DialogTitle>{t("SETTINGS$SKILLS_FILTERS_MODAL_TITLE")}</DialogTitle>
      <div className="max-h-[60vh] overflow-y-auto">
        {groups.length ? <SkillFacetRail groups={groups} onToggle={onToggle} /> : <p className="oh-skills-detail-note">{t("SKILLS_PM$NO_FILTER_CHOICES")}</p>}
      </div>
      <div className="flex items-center justify-end gap-2">
        {activeCount ? <BrandButton type="button" variant="secondary" testId="skill-filters-modal-clear" onClick={onClearAll}>
          {t("SETTINGS$SKILLS_CLEAR_FILTERS")}
        </BrandButton> : null}
        <BrandButton type="button" variant="primary" testId="skill-filters-modal-done" onClick={onClose}>{t("BUTTON$CLOSE")}</BrandButton>
      </div>
    </DialogContent>
  </Dialog>;
}
