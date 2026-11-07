// Adapted from t3code d53873b6 ComposerCommandMenu.tsx. MIT; LICENSE.t3code.
import type { ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@agent-workspace/client-runtime";
import {
  BlocksIcon,
  FileIcon,
  FolderIcon,
  PackageIcon,
  SettingsIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";

import { useAgentText } from "../i18n";

type Skill = ProviderSkillsSnapshot["skills"][number];
type Command = ProviderSkillsSnapshot["commands"][number];

export type ComposerTriggerKind = "path" | "skill" | "slash-command";

export type ComposerMenuItem =
  | {
      id: string;
      type: "file";
      path: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: Skill;
      label: string;
      description: string;
      /** Text inserted into the composer when the item is picked. */
      value: string;
    }
  | {
      id: string;
      type: "command";
      command: Command;
      label: string;
      description: string;
      /** Text inserted into the composer when the item is picked. */
      value: string;
    };

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, [fallback: string, translated: string]> = {
  path: ["Files", "文件"],
  skill: ["Skills", "Skills"],
  "slash-command": ["Commands", "命令"],
};

const SKILL_SOURCE_ICON: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL: Record<ProviderSkillSourceKind, [fallback: string, translated: string]> = {
  app: ["App", "应用"],
  repo: ["Repo", "仓库"],
  project: ["Project", "项目"],
  personal: ["Personal", "个人"],
  system: ["System", "系统"],
  other: ["Provider", "Provider"],
};

/**
 * The composer's single suggestion surface: `@` files, `$` skills and `/`
 * commands share one listbox so keyboard handling never depends on which
 * trigger opened it.
 */
export function ComposerCommandMenu(props: {
  listId: string;
  triggerKind: ComposerTriggerKind;
  items: readonly ComposerMenuItem[];
  activeIndex: number;
  status?: string;
  truncated?: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: ComposerMenuItem) => void;
}) {
  const t = useAgentText();
  const listId = props.listId;
  const [labelFallback, labelTranslated] = LISTBOX_LABEL_BY_TRIGGER[props.triggerKind];

  useEffect(() => {
    document.getElementById(`${listId}-${props.activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, props.activeIndex, props.items.length]);

  return (
    <div className="composer-command-menu" data-composer-command-menu="true">
      {props.items.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t(labelFallback, labelTranslated)}
          className="composer-command-list"
        >
          {props.items.map((item, index) => (
            <ComposerCommandMenuItem
              key={item.id}
              id={`${listId}-${index}`}
              item={item}
              active={index === props.activeIndex}
              triggerKind={props.triggerKind}
              onHighlight={() => props.onHighlight(index)}
              onSelect={() => props.onSelect(item)}
            />
          ))}
        </div>
      ) : (
        <p className="composer-command-status" role="status">
          {props.status ?? t("没有匹配项。", "No matching entries.")}
        </p>
      )}
      {props.items.length > 0 && props.truncated ? (
        <p className="composer-command-note">
          {t("结果已截断，继续输入以缩小范围。", "Results are truncated; keep typing to narrow them.")}
        </p>
      ) : null}
    </div>
  );
}

function ComposerCommandMenuItem(props: {
  id: string;
  item: ComposerMenuItem;
  active: boolean;
  triggerKind: ComposerTriggerKind;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const t = useAgentText();
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const Icon =
    props.item.type === "file"
      ? FileIcon
      : props.item.type === "skill"
        ? SparklesIcon
        : SquareTerminalIcon;
  const sourceLabel = skillSourceKind ? SKILL_SOURCE_LABEL[skillSourceKind] : null;
  const SourceIcon = skillSourceKind ? SKILL_SOURCE_ICON[skillSourceKind] : null;

  return (
    <button
      type="button"
      id={props.id}
      role="option"
      aria-selected={props.active}
      data-composer-suggestion-id={props.item.id}
      className="composer-command-item"
      onMouseMove={() => {
        if (!props.active) props.onHighlight();
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
    >
      <Icon aria-hidden="true" className="composer-command-icon" />
      <span className="composer-command-label">
        {props.item.type === "skill" && props.triggerKind === "slash-command" ? (
          <>
            <span className="composer-command-prefix">/skill:</span>
            {props.item.skill.name}
          </>
        ) : (
          props.item.label
        )}
      </span>
      <span className="composer-command-description">{props.item.description}</span>
      {skillSourceKind && SourceIcon && sourceLabel ? (
        <span className="composer-command-badge">
          <SourceIcon aria-hidden="true" />
          {t(...sourceLabel)}
        </span>
      ) : null}
    </button>
  );
}
