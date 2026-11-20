import { useEffect, useState } from "react";
import { useAgentText } from "../i18n";
import { SettingsNotice, SettingsSection } from "./settings-layout";
import { setChatBrowserPreferences, useChatBrowserPreferences } from "./browser-preferences";
import { RadixSelect } from "@/components/ui/radix-select"
import {
  COMPOSER_SHORTCUT_ACTIONS, conflictingActions, formatShortcutChord, normalizeShortcutChord, rebindComposerKeymap,
  resetComposerKeymapBinding, resolveComposerKeymap, shortcutChordFromEvent, type ComposerShortcutAction,
} from "../chat/composer-shortcuts";

const actionLabels: Record<ComposerShortcutAction, [string, string]> = {
  send: ["发送消息", "Send message"],
  newline: ["输入换行", "Insert line break"],
  steer: ["发送并引导当前回合", "Send and steer the running turn"],
  togglePlan: ["切换计划模式", "Toggle Plan mode"],
};

const reservedRows: Array<[string, string, string]> = [
  ["当前作用域新建会话", "New session in current scope", "Ctrl / ⌘ + Shift + O"],
  ["搜索已保存会话", "Search saved sessions", "Ctrl / ⌘ + K"],
  ["请求停止当前生成", "Stop current generation", "Ctrl / ⌘ + ."],
  ["切换会话详情", "Toggle session details", "Ctrl / ⌘ + Shift + B"],
  ["切换终端抽屉", "Toggle terminal drawer", "Ctrl / ⌘ + J"],
  ["切换右侧面板", "Toggle right panel", "Ctrl / ⌘ + Alt + B"],
  ["打开快捷键帮助", "Open shortcut help", "?"],
];

/** One press is captured; Escape cancels, Backspace restores the default, and a saved chord closes the recorder. */
function useShortcutRecorder(onChord: (action: ComposerShortcutAction, chord: string) => boolean, onClear: (action: ComposerShortcutAction) => void) {
  const [recording, setRecording] = useState<ComposerShortcutAction | null>(null);
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setRecording(null);
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onClear(recording);
        setRecording(null);
        return;
      }
      const chord = shortcutChordFromEvent(event);
      if (!chord) return;
      // Never let a half-recorded chord reach the global shortcut handlers.
      event.preventDefault();
      event.stopPropagation();
      if (onChord(recording, chord)) setRecording(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, onChord, onClear]);
  return { recording, setRecording };
}

export function ShortcutCatalog() {
  const t = useAgentText();
  const { preferences } = useChatBrowserPreferences();
  const keymap = resolveComposerKeymap(preferences.composerKeymap, preferences.sendShortcut);
  return <div className="agent-shortcuts">
    <dl>
      {COMPOSER_SHORTCUT_ACTIONS.map(action => <div key={action}><dt>{t(...actionLabels[action])}</dt><dd><kbd>{formatShortcutChord(keymap[action])}</kbd></dd></div>)}
      {reservedRows.map(([zh, en, keys]) => <div key={keys}><dt>{t(zh, en)}</dt><dd><kbd>{keys}</kbd></dd></div>)}
    </dl>
    <p>{t("输入区的四个快捷键可在设置中重新绑定；其余快捷键固定。", "The four composer shortcuts can be rebound in Settings; the rest are fixed.")}</p>
  </div>;
}

export default function InputPreferences() {
  const t = useAgentText();
  const { preferences, storageError } = useChatBrowserPreferences();
  const keymap = resolveComposerKeymap(preferences.composerKeymap, preferences.sendShortcut);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const applyChord = (action: ComposerShortcutAction, chord: string): boolean => {
    setError(undefined);
    setConflict(undefined);
    setNotice(undefined);
    const normalized = normalizeShortcutChord(chord);
    if (!normalized) {
      setError(t("这个组合无法绑定：请使用修饰键，或 Tab / Enter / 方向键等不输入字符的键。", "That chord cannot be bound: use a modifier, or a key that types nothing such as Tab, Enter or an arrow key."));
      return false;
    }
    const result = rebindComposerKeymap(preferences.composerKeymap, keymap, action, normalized);
    if ("conflict" in result) {
      const labels = result.conflict.map(other => t(...actionLabels[other])).join(t("、", ", "));
      setConflict(t(`与「${labels}」冲突，先改掉那一项。`, `Conflicts with "${labels}"; rebind that one first.`));
      return false;
    }
    setChatBrowserPreferences({ composerKeymap: result.overrides });
    if (result.swapped) setNotice(t(`已与「${t(...actionLabels[result.swapped])}」交换快捷键。`, `Swapped shortcuts with "${t(...actionLabels[result.swapped])}".`));
    return true;
  };
  const clearChord = (action: ComposerShortcutAction) => {
    setError(undefined);
    setConflict(undefined);
    setChatBrowserPreferences({ composerKeymap: resetComposerKeymapBinding(preferences.composerKeymap, action) });
  };
  const { recording, setRecording } = useShortcutRecorder(applyChord, clearChord);
  const conflicts = new Set(COMPOSER_SHORTCUT_ACTIONS.filter(action => conflictingActions(keymap, action, keymap[action]).length));

  return <SettingsSection title={t("输入与快捷键", "Input & shortcuts")} scope="browser">
    <div className="agent-preference-row"><label htmlFor="agent-send-shortcut">{t("发送方式", "Send with")}</label><RadixSelect id="agent-send-shortcut" value={preferences.sendShortcut} onChange={(event) => setChatBrowserPreferences({ sendShortcut: event.target.value as "enter" | "ctrlEnter" })}><option value="enter">{t("Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for a line break")}</option><option value="ctrlEnter">{t("Ctrl / ⌘+Enter 发送 · Enter 换行", "Ctrl / ⌘+Enter to send · Enter for a line break")}</option></RadixSelect></div>
    <div className="agent-shortcuts">
      <dl>
        {COMPOSER_SHORTCUT_ACTIONS.map(action => <div key={action}>
          <dt>{t(...actionLabels[action])}</dt>
          <dd className="inline-flex items-center gap-2">
            <kbd>{recording === action ? t("按下新的组合键…", "Press the new chord…") : formatShortcutChord(keymap[action])}</kbd>
            <button type="button" className="text-xs underline" onClick={() => { setError(undefined); setConflict(undefined); setRecording(action); }}>{t("更改", "Change")}</button>
            {preferences.composerKeymap[action] && <button type="button" className="text-xs underline" onClick={() => clearChord(action)}>{t("恢复默认", "Reset")}</button>}
          </dd>
        </div>)}
      </dl>
      {recording && <p role="status">{t("按 Esc 取消；按 Backspace 恢复默认。", "Press Esc to cancel; press Backspace to restore the default.")}</p>}
      {notice && <SettingsNotice kind="info">{notice}</SettingsNotice>}
      {error && <SettingsNotice kind="error">{error}</SettingsNotice>}
      {conflict && <SettingsNotice kind="error">{conflict}</SettingsNotice>}
      {conflicts.size > 0 && !conflict && <SettingsNotice kind="error">{t("有快捷键重复绑定，编辑器按动作顺序取第一个匹配项。请改掉重复项。", "Two composer shortcuts share a chord; the editor takes the first matching action. Rebind the duplicate.")}</SettingsNotice>}
      {storageError && <SettingsNotice kind="error">{storageError}</SettingsNotice>}
    </div>
    <ShortcutCatalog />
  </SettingsSection>;
}
