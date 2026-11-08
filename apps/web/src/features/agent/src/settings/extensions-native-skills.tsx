import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagementEvent } from "@pm/cc-switch-ui";
import { Button } from "@agent/components/ui/button";
import { useAgentText } from "../i18n";
import { SettingsNotice } from "./settings-layout";
import "./extensions-native-skills.css";

type NativeSkill = { directory: string; name: string; description?: string; foundIn: string[]; managed: boolean };
type Props = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: ManagementEvent) => void): () => void;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
};

/** Observations stay separate from the managed library and runtime-loaded skill catalog. */
export function ExtensionNativeSkills({ invoke, subscribe, disabled, onBusyChange }: Props) {
  const t = useAgentText();
  const [skills, setSkills] = useState<NativeSkill[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [adopting, setAdopting] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const live = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const load = useCallback(async () => {
    if (!live.current) return;
    const request = ++sequence.current;
    setLoading(true); setError(undefined);
    try {
      const result = await invoke<NativeSkill[]>("scan_native_skills");
      if (live.current && sequence.current === request) setSkills(result);
    } catch (cause) {
      if (live.current && sequence.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (live.current && sequence.current === request) setLoading(false);
    }
  }, [invoke]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; ++sequence.current; };
  }, [load]);
  useEffect(() => subscribe(event => {
    if (!pending.current && (event.event === "changed" || event.event === "reconnected")) void load();
  }), [subscribe, load]);
  const adopt = async (skill: NativeSkill) => {
    if (disabled || loading || error || skill.managed || pending.current) return;
    pending.current = true; setAdopting(skill.directory); onBusyChange(true);
    setActionError(undefined); setNotice(undefined);
    try {
      // Copy into the real cc-switch library only after an explicit click. Empty
      // assignments do not deploy this skill into any additional native target.
      const imported = await invoke<unknown[]>("import_skills_from_apps", { imports: [{ directory: skill.directory, apps: {} }] });
      if (imported.length !== 1) throw new Error(t("原生条目已变化或未导入；请核对刷新后的目录。", "The native entry changed or was not imported; check the refreshed inventory."));
      if (live.current) setNotice(t("已纳入管理库；未为其他原生目标安装。运行中会话是否加载仍须单独核对。", "Added to the managed library without installing into additional native targets. Running-session loading must still be checked separately."));
    } catch (cause) {
      if (live.current) setActionError(`${cause instanceof Error ? cause.message : String(cause)} ${t("正在重新读取权威状态；重试前请核对管理库。", "Re-reading authoritative state; check the managed library before retrying.")}`);
    } finally {
      await load();
      pending.current = false;
      if (live.current) { setAdopting(undefined); onBusyChange(false); }
    }
  };
  return <section className="settings-native-skills" aria-label={t("本机已有 Skills", "Existing local Skills")}>
    <div className="settings-native-skills-heading"><h2>{t("本机已有 Skills · 原生目录观测", "Existing local Skills · native-directory observations")}</h2><Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={() => void load()}>{t("刷新只读发现", "Refresh read-only discovery")}</Button></div>
    <p>{t("“本机”指当前 Agent 服务所在机器：桌面本地模式是这台电脑；连接远程服务时是远端主机，不是浏览器电脑。这里只观察已绑定 Provider 的原生目录及其 Home/.agents/skills，不导入、不安装，也不证明运行中会话已加载。", "“Local” means the current Agent service machine: this computer in desktop local mode, or the remote host when connected remotely—not the browser computer. This only observes bound Providers’ native directories and their Home/.agents/skills; it does not import, install, or prove a running session has loaded a skill.")}</p>
    <p>{t("“纳入管理库”会复制所选条目到当前管理库，不分配到额外原生目标；Pi / OMP 继续按实际目录观测。", "“Adopt into library” copies the selected entry into this managed library without assigning additional native targets; Pi / OMP remain native-directory observations.")}</p>
    {loading && <SettingsNotice kind="loading">{t("正在只读发现…", "Discovering read-only…")}</SettingsNotice>}
    {error && <SettingsNotice kind="error" onRetry={() => void load()}>{error}</SettingsNotice>}
    {actionError && <SettingsNotice kind="error">{actionError}</SettingsNotice>}
    {notice && <p role="status">{notice}</p>}
    {!loading && !error && skills && (skills.length ? <ul>{skills.map(skill => <li key={skill.directory}>
      <div><strong>{skill.name}</strong><code>{skill.directory}</code>{skill.description && <p>{skill.description}</p>}<span>{t("发现位置", "Found in")}: {skill.foundIn.join(" · ")}</span></div>
      {skill.managed ? <span>{t("已纳入管理库 · 不代表运行时加载", "In managed library · not a runtime-loaded claim")}</span> : <Button type="button" variant="outline" size="sm" disabled={disabled || !!adopting} onClick={() => void adopt(skill)}>{adopting === skill.directory ? t("正在纳入…", "Adopting…") : t("纳入管理库", "Adopt into library")}</Button>}
    </li>)}</ul> : <p role="status">{t("已检查绑定的本机目录；没有发现原生 Skills。下方管理库与 Composer 可调用目录分别展示。", "The bound local directories were checked; no native Skills were found. The managed library below and Composer’s callable catalog remain separate.")}</p>)}
  </section>;
}
