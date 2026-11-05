// Adapted from t3code d53873b6 ChatComposer, useComposerMenuItems,
// useComposerCommandKey, SkillInlineText and useProviderWorkspaceSnapshotRefresh. MIT; LICENSE.t3code.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAui, useAuiState } from "@assistant-ui/react";
import { acceptThreadSettings } from "@agent/hooks/use-chat-settings";
import type { ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import type { RemoteThread } from "@agent-workspace/contracts/chat";
import { collectComposerInlineTokens, detectComposerTrigger, formatProviderSkillDisplayName, getProviderSlashCommandsForSlashMenu, getProviderSkillsForSlashMenu, isProviderSkillUserInvocable, replaceTextRange, resolveProviderSkillSourceKind, searchProviderSkills } from "@agent-workspace/client-runtime";
import { acceptRemoteThread, scopeContext, threadScope, usePmChatState } from "../pm/state";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import "./provider-skills.css";

type Skill = ProviderSkillsSnapshot["skills"][number];
type Picked = { thread: string; kind: "skill" | "command"; name: string; path: string; binding: string };
const TTL = 5 * 60_000;

export function useProviderSkillsComposer(instanceId: string, disabled: boolean) {
  const t = useAgentText();
  const location = useLocation();
  const aui = useAui();
  const state = usePmChatState();
  const localId = useAuiState(s => s.threads.mainThreadId);
  const remoteId = useAuiState(s => s.threads.threadItems.find(item => item.id === s.threads.mainThreadId)?.remoteId);
  const text = useAuiState(s => s.composer.text);
  const running = useAuiState(s => s.thread.isRunning || s.thread.isLoading);
  const scope = threadScope(localId, remoteId);
  const fileArea = scopeContext(state.catalog, scope)?.fileArea;
  const provider = state.providers.find(item => item.instanceId === instanceId);
  const key = JSON.stringify([localId, scope?.workspaceId, scope?.projectId, instanceId, provider?.revision, fileArea?.path, fileArea?.revision]);
  const liveKey = useRef(key); liveKey.current = key;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const lastRequest = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ key: string; snapshot?: ProviderSkillsSnapshot; error?: string; loading: boolean }>({ key, loading: false });
  const [cursor, setCursor] = useState(text.length);
  const [dismissed, setDismissed] = useState<string>();
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartNotice, setRestartNotice] = useState<string>();
  const menuId = useId();
  const available = !!scope && fileArea?.status === "available" && !!provider?.nativeSessionReady && !state.error && !state.providerError;
  const snapshot = result.key === key ? result.snapshot : undefined;
  const binding = snapshot ? JSON.stringify([key, snapshot.revision, snapshot.cwd]) : "";
  const current = available && !!snapshot && Date.now() - Date.parse(snapshot.checkedAt) < TTL && !snapshot.error && !result.error && !result.loading && (provider?.revision === undefined || snapshot.revision === provider.revision);
  const refresh = useCallback(async (fresh = true) => {
    if (liveKey.current !== key || !available || !scope || controller.current && !controller.current.signal.aborted && Date.now() - lastRequest.current < 1000) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    lastRequest.current = Date.now();
    setResult(previous => ({ key, loading: true, ...(previous.key === key ? { snapshot: previous.snapshot } : {}) }));
    try {
      const value = await workspaceClient.json<ProviderSkillsSnapshot>(`/api/providers/${encodeURIComponent(instanceId)}/skills/refresh`, { method: "POST", body: JSON.stringify({ scope, fresh }), signal: abort.signal });
      if (abort.signal.aborted || liveKey.current !== key) return;
      if (value.instanceId !== instanceId) throw new Error(t("Skill 目录实例不匹配。", "Skill catalog instance mismatch."));
      setResult({ key, snapshot: value, loading: false });
    } catch (cause) {
      if (!abort.signal.aborted && liveKey.current === key) setResult(previous => ({ ...previous, key, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, [available, instanceId, key, scope?.workspaceId, scope?.projectId, t]);
  useEffect(() => {
    lastRequest.current = 0;
    setDismissed(undefined); setHighlight(0); setRestartNotice(undefined);
    void refresh(false);
    return () => controller.current?.abort();
  }, [key, available]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ providerInstanceIds?: string[] }>).detail;
      if (detail?.providerInstanceIds?.includes(instanceId)) void refresh(true);
    };
    window.addEventListener("agent-native-configuration-changed", changed);
    return () => window.removeEventListener("agent-native-configuration-changed", changed);
  }, [instanceId, refresh]);
  useEffect(() => {
    if (!snapshot?.pending) return;
    const timer = window.setTimeout(() => void refresh(false), 10_000);
    return () => clearTimeout(timer);
  }, [snapshot, refresh]);
  const onInput = (node: HTMLTextAreaElement) => {
    setCursor(node.selectionStart); setDismissed(undefined); setHighlight(0);
    if (Date.now() - lastRequest.current > TTL) void refresh(false);
  };
  const trigger = !disabled && !composing.current ? detectComposerTrigger(text, cursor) : null;
  const triggerKey = trigger ? JSON.stringify([key, text, cursor]) : undefined;
  const visible = trigger && (trigger.kind === "skill" || trigger.kind === "slash-command") && dismissed !== triggerKey;
  const slashSkills = current && snapshot?.invocation.skills ? getProviderSkillsForSlashMenu(snapshot.skills, true) : [];
  const skillItems = current && snapshot?.invocation.skills && visible ? searchProviderSkills(trigger.kind === "slash-command" ? slashSkills : snapshot.skills, trigger.query.replace(/^skill:/, ""), 50).map(skill => ({ id: `skill:${skill.path}`, label: trigger.kind === "slash-command" ? `/skill:${skill.name}` : formatProviderSkillDisplayName(skill), description: skill.shortDescription ?? skill.description, skill, value: `$${skill.name} ` })) : [];
  const commands = current && snapshot && !snapshot.pending && visible && trigger.kind === "slash-command" ? getProviderSlashCommandsForSlashMenu(snapshot.commands, slashSkills)
    .filter(command => (snapshot.invocation.commands || snapshot.invocation.commandAllowlist?.includes(command.name)) && !snapshot.skills.some(skill => !isProviderSkillUserInvocable(skill) && (command.name === skill.name || command.name === `skill:${skill.name}`)) && command.name.toLowerCase().includes(trigger.query.toLowerCase()))
    .map(command => ({ id: `command:${command.name}`, label: `/${command.name}`, description: command.description ?? command.input?.hint, skill: undefined, value: `/${command.name} ` })) : [];
  const items = [...skillItems, ...commands].slice(0, 60);
  const index = Math.min(highlight, Math.max(0, items.length - 1));
  useEffect(() => { if (visible) document.getElementById(`${menuId}-${index}`)?.scrollIntoView({ block: "nearest" }); }, [visible, menuId, index]);
  const select = (item: typeof items[number]) => {
    if (!current || !snapshot || !trigger || !inputRef.current || composing.current) return;
    const source = aui.composer.getState().text;
    if (source !== text) return;
    const end = source[trigger.rangeEnd] === " " ? trigger.rangeEnd + 1 : trigger.rangeEnd;
    let edit = replaceTextRange(source, trigger.rangeStart, end, item.value);
    if (item.skill && snapshot.invocation.skillSyntax === "leading-mention") {
      let body = replaceTextRange(source, trigger.rangeStart, end, "").text;
      const existing = collectComposerInlineTokens(`${body} `).find(token => token.type === "skill" && token.start === 0);
      if (existing) body = body.slice(Math.min(body.length, existing.end + (body[existing.end] === " " ? 1 : 0)));
      edit = { text: `${item.value}${body}`, cursor: item.value.length };
    }
    aui.composer.setText(edit.text);
    const choice: Picked = item.skill ? { thread: localId, kind: "skill", name: item.skill.name, path: item.skill.path, binding } : { thread: localId, kind: "command", name: item.value.slice(1).trim(), path: item.id, binding };
    setPicked(previous => [...previous.filter(p => p.thread !== localId || p.kind !== choice.kind || p.name !== choice.name), choice]);
    setDismissed(undefined); setCursor(edit.cursor); setHighlight(0);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(edit.cursor, edit.cursor); });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !visible) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(triggerKey); return true; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault(); setHighlight((index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length); return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && items[index]) { event.preventDefault(); select(items[index]); return true; }
    return false;
  };
  const tokens = collectComposerInlineTokens(`${text} `).filter(token => token.type === "skill");
  const commandTokens = [...text.matchAll(/(^|\s)\/([^\s/]+)(?=\s|$)/g)].map(match => ({ name: match[2]!, start: match.index + match[1]!.length, end: match.index + match[0].length }));
  const pickedCommands = picked.filter(p => p.thread === localId && p.kind === "command" && commandTokens.some(token => token.name === p.name));
  const invalid = picked.filter(p => p.thread === localId && (p.kind === "skill" ? tokens.some(token => token.value === p.name) : commandTokens.some(token => token.name === p.name)) && (!current || p.binding !== binding || (p.kind === "skill" ? !snapshot?.invocation.skills || !snapshot.skills.some(skill => skill.path === p.path && skill.name === p.name && isProviderSkillUserInvocable(skill)) : !snapshot || snapshot.pending || !snapshot.commands.some(command => command.name === p.name && (snapshot.invocation.commands || snapshot.invocation.commandAllowlist?.includes(command.name))))));
  const remove = (name: string) => {
    const source = aui.composer.getState().text;
    const matches = collectComposerInlineTokens(`${source} `).filter(token => token.type === "skill" && token.value === name);
    let next = source;
    for (const token of [...matches].reverse()) next = next.slice(0, token.start) + next.slice(Math.min(source.length, token.end + (source[token.end] === " " ? 1 : 0)));
    aui.composer.setText(next); setPicked(previous => previous.filter(p => p.thread !== localId || p.name !== name));
  };
  const removeCommand = (name: string) => {
    let next = aui.composer.getState().text;
    for (const token of commandTokens.filter(token => token.name === name).reverse()) next = next.slice(0, token.start) + next.slice(token.end);
    aui.composer.setText(next); setPicked(previous => previous.filter(p => p.thread !== localId || p.kind !== "command" || p.name !== name));
  };
  const restart = async () => {
    if (!remoteId || disabled || running || restarting || !window.confirm(t("重启当前原生 Agent session？历史和草稿保留，原生连续性及旧 App 会失效。不会自动发送消息。", "Restart this native Agent session? History and drafts remain, but native continuity and old Apps are invalidated. No message is sent automatically."))) return;
    setRestarting(true); setRestartNotice(undefined);
    try {
      const value = await workspaceClient.json<{ thread: RemoteThread }>(`/api/chat/threads/${encodeURIComponent(remoteId)}/native-session/restart`, { method: "POST", body: "{}" });
      acceptRemoteThread(value.thread);
      acceptThreadSettings(value.thread);
      window.dispatchEvent(new CustomEvent("agent-native-session-restarted", { detail: { threadId: remoteId } }));
      if (liveKey.current === key) {
        setRestartNotice(t("原生 session 已重置；下一次明确发送会创建新 session。", "Native session reset; your next explicit message starts a new session."));
        await refresh(true);
      }
    } catch (cause) { if (liveKey.current === key) setRestartNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRestarting(false); }
  };
  const status = !available ? t("先选择可用的 Provider 与作用域。", "Choose an available provider and scope first.") : result.key !== key || result.loading ? t("正在读取原生目录…", "Loading native catalog…") : result.error || snapshot?.error?.message || (!snapshot ? t("没有可用快照。", "No snapshot available.") : !current ? t("目录快照已过期或实例版本已改变，请刷新。", "The catalog snapshot expired or its instance revision changed. Refresh the catalog.") : snapshot.pending ? t("已发现的安全 Skills 可选择；命令目录尚未完整，将在同范围原生 Chat 活跃后刷新。", "Discovered safe Skills are selectable. The command inventory is incomplete and refreshes when a same-scope native Chat is live.") : !snapshot.skills.length && !snapshot.commands.length ? t("此原生目录为空。", "This native catalog is empty.") : undefined);
  return {
    inputRef, onInput, onKeyDown,
    beforeSend: () => {
      if (invalid.length || restarting || liveKey.current !== key) return false;
      const hasSelection = picked.some(p => p.thread === localId && (p.kind === "skill" ? tokens.some(token => token.value === p.name) : commandTokens.some(token => token.name === p.name)));
      if (hasSelection && (!snapshot || Date.now() - Date.parse(snapshot.checkedAt) >= TTL)) { void refresh(false); return false; }
      return true;
    },
    onCompositionStart: () => { composing.current = true; setDismissed(triggerKey); },
    onCompositionEnd: (node: HTMLTextAreaElement) => { composing.current = false; onInput(node); },
    blocked: invalid.length > 0 || restarting,
    inputAria: { "aria-controls": visible ? menuId : undefined, "aria-expanded": !!visible, "aria-activedescendant": visible && items[index] ? `${menuId}-${index}` : undefined, "aria-autocomplete": "list" as const },
    surface: <div className="native-skills-composer">
      <div className="native-skills-toolbar"><button type="button" onClick={() => setDirectoryOpen(value => !value)} aria-expanded={directoryOpen}>{t("原生 Skills / 命令", "Native Skills / commands")}</button><button type="button" disabled={!available || result.loading} onClick={() => void refresh(true)}>{t("刷新目录", "Refresh catalog")}</button><button type="button" disabled={!remoteId || disabled || running || restarting} onClick={() => void restart()}>{restarting ? t("正在重启…", "Restarting…") : t("重启原生 session", "Restart native session")}</button></div>
      <Link to={`/agent/settings/skills?provider=${encodeURIComponent(instanceId)}`} state={{ settingsReturnTo: `${location.pathname}${location.search}${location.hash}` }}>{t("管理原生 Skills（cc-switch）", "Manage native Skills (cc-switch)")}</Link>
      {snapshot?.nativeConfiguration?.reloadRequired && <p role="status">{t("原生配置已变更；已安装不等于当前会话已加载。活跃执行保持不变。请刷新目录，并按需显式重启原生 session 或新建对话。", "Native configuration changed; installed does not mean loaded in this session. Active executions are preserved. Refresh the catalog and explicitly restart the native session or start a new chat when needed.")}</p>}
      {tokens.length > 0 && <div className="native-skill-chips" aria-label={t("原生 Skill 引用", "Native Skill references")}>{tokens.map(token => { const skill = current && snapshot ? snapshot.skills.find(skill => skill.name === token.value && isProviderSkillUserInvocable(skill)) : undefined; return <button key={`${token.start}:${token.value}`} type="button" data-invalid={invalid.some(p => p.name === token.value)} title={skill?.path ?? token.source} onClick={() => remove(token.value)}>{skill ? formatProviderSkillDisplayName(skill) : `$${token.value}`} <span aria-label={t("移除引用", "Remove reference")}>×</span></button>; })}</div>}
      {pickedCommands.length > 0 && <div className="native-skill-chips">{pickedCommands.map(command => <button key={command.name} type="button" data-invalid={invalid.includes(command)} onClick={() => removeCommand(command.name)}>/{command.name} ×</button>)}</div>}
      {snapshot?.invocation.skillSyntax === "leading-mention" && <p>{t("此 Provider 每条消息仅原生调用开头的一个 Skill；选择会将引用放在消息最前面。", "This provider natively invokes only one leading Skill per message; selecting places its reference at the start.")}</p>}
      {invalid.length > 0 && <p role="alert">{t("已选 Skill 的实例、目录或作用域已变化。请移除旧引用并从当前目录重新选择后发送。", "A selected Skill's instance, directory or scope changed. Remove the stale reference and select from the current catalog before sending.")}</p>}
      {restartNotice && <p role="status">{restartNotice}</p>}
      {visible && <div className="native-skills-menu" id={menuId} role="listbox" aria-label={t("原生 Skill 与命令建议", "Native Skill and command suggestions")}>{status && <p role="status">{status}</p>}{!items.length && !status ? <p>{t("没有匹配的可调用项。", "No matching invocable entries.")}</p> : items.map((item, i) => <button type="button" role="option" id={`${menuId}-${i}`} aria-selected={index === i} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => select(item)}><strong>{item.label}</strong><small>{item.description}</small>{item.skill && <small>{resolveProviderSkillSourceKind(item.skill)} · {item.skill.path}</small>}</button>)}</div>}
      {directoryOpen && <section className="native-skills-directory" aria-label={t("当前作用域的原生目录", "Native catalog for the current scope")}><p>{t("原生目录只读；请在 Provider 原生位置安装或修改，再刷新。保存的用户指令块是另一种功能。", "Native catalog is read-only. Install or edit at the provider's native location, then refresh. Saved user instruction blocks are separate.")}</p>{status && <p role={result.error || snapshot?.error ? "alert" : "status"}>{status}</p>}{snapshot && <><p><code>{snapshot.cwd}</code> · r{snapshot.revision} · <time>{snapshot.checkedAt}</time>{!current && ` · ${t("陈旧 / 不可调用", "Stale / not invocable")}`}</p>{!snapshot.invocation.skills && <p>{t("此 Provider 不支持当前原生 Skill 调用，目录仍可查看。", "This provider does not support native Skill invocation here; its catalog remains readable.")}</p>}<ul>{snapshot.skills.map((skill: Skill) => <li key={`${skill.name}:${skill.path}`}><strong>{formatProviderSkillDisplayName(skill)}</strong> · {resolveProviderSkillSourceKind(skill)} · {!skill.enabled ? t("已禁用", "Disabled") : skill.userInvocable === false ? t("仅 Agent 可调用", "Agent-only") : snapshot.invocation.skills ? t("用户可调用", "User-invocable") : t("调用不可用", "Invocation unavailable")}<p>{skill.shortDescription ?? skill.description}</p><code>{skill.path}</code></li>)}{snapshot.commands.map(command => <li key={`command:${command.name}`}><strong>/{command.name}</strong><p>{command.description ?? command.input?.hint}</p></li>)}</ul></>}</section>}
    </div>,
  };
}
