import React from "react";
import { Copy, Check } from "lucide-react";
import { useOpenHandsTranslation } from "@pm/openhands-source/web/i18n";
import type { SkillInfo } from "@pm/openhands-source/types/settings";
import { BrandButton } from "@pm/openhands-source/components/features/settings/brand-button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, copyText, toast } from "@pm/cc-switch-ui";
import { SkillIconBadge } from "./skill-icon-badge";
import { getSkillCardDescription } from "./get-skill-card-description";
import { buildSkillPills } from "./build-skill-pills";
import { isCopyableSkillSource } from "./is-copyable-skill-source";
import { SkillCardPillRow } from "./skill-card-pill-row";

interface SkillDetailModalProps {
  skill: SkillInfo;
  onClose: () => void;
  busy?: boolean;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}

/** OpenHands detail presentation; the host supplies real per-Agent lifecycle controls. */
export function SkillDetailModal({ skill, onClose, busy = false, children, actions }: SkillDetailModalProps) {
  const { t } = useOpenHandsTranslation();
  const [sourceCopied, setSourceCopied] = React.useState(false);
  const description = getSkillCardDescription(skill);
  const pills = React.useMemo(() => buildSkillPills(skill, t, {
    variant: "detail", testIdPrefix: "skill-modal-pill",
  }), [skill, t]);
  React.useEffect(() => {
    if (!sourceCopied) return;
    const timeout = setTimeout(() => setSourceCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [sourceCopied]);
  const copySource = async () => {
    if (!skill.source) return;
    try { await copyText(skill.source); setSourceCopied(true); }
    catch (error) { toast.error(String(error)); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent data-testid="skill-detail-modal" data-skill-name={skill.name} className="oh-skill-detail">
      <header className="flex flex-shrink-0 items-start gap-3 pb-4 pl-6 pr-6 pt-6">
        <SkillIconBadge skillName={skill.name} />
        <div className="min-w-0 flex-1">
          <DialogTitle className="break-words">{skill.name}</DialogTitle>
          {skill.source ? <div className="mt-0.5 flex min-w-0 items-center gap-1">
            <p className="min-w-0 flex-1 break-words text-xs text-tertiary-alt">{skill.source}</p>
            {isCopyableSkillSource(skill.source) ? <button type="button" disabled={sourceCopied}
              aria-label={t(sourceCopied ? "BUTTON$COPIED" : "SETTINGS$SKILLS_COPY_PATH")}
              onClick={() => void copySource()} className="shrink-0 p-1 text-tertiary-alt">
              {sourceCopied ? <Check size={14} /> : <Copy size={14} />}
            </button> : null}
          </div> : null}
        </div>
      </header>
      <div data-testid="skill-detail-modal-content" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
        <DialogDescription className="break-words whitespace-pre-line text-xs text-tertiary-light">
          {description || skill.name}
        </DialogDescription>
        {pills.length ? <SkillCardPillRow pills={pills} testId={`skill-modal-pills-${skill.name}`} /> : null}
        {children}
        {skill.content ? <label className="flex min-w-0 flex-col gap-2 text-sm">
          {t("SETTINGS$SKILLS_CONTENT")}
          <textarea readOnly value={skill.content} rows={Math.min(12, Math.max(4, skill.content.split("\n").length))}
            className="w-full resize-none rounded-sm border border-border-subtle bg-surface-raised p-2 text-sm" />
        </label> : null}
      </div>
      <footer data-testid="skill-detail-modal-actions" className="flex flex-shrink-0 flex-wrap justify-end gap-2 px-6 pb-6 pt-4">
        {actions}
        <BrandButton type="button" variant="secondary" isDisabled={busy} onClick={onClose} testId="skill-detail-close">
          {t("BUTTON$CLOSE")}
        </BrandButton>
      </footer>
    </DialogContent>
  </Dialog>;
}
