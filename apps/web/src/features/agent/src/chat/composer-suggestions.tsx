// Adapted from t3code d53873b6 composerTrigger.ts, useComposerMenuItems.ts,
// ComposerCommandMenu.tsx, ChatComposer.tsx, SkillInlineText and
// useProviderWorkspaceSnapshotRefresh. MIT; LICENSE.t3code.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import type {
  InspectorSearchEntry,
  InspectorSearchResponse,
} from "@agent-workspace/contracts/inspector";
import type { ProviderSkillsSnapshot } from "@agent-workspace/contracts/provider";
import {
  collectComposerInlineTokens,
  detectComposerTrigger,
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  isProviderSkillUserInvocable,
  replaceTextRange,
  searchProviderSkills,
  serializeComposerFileLink,
} from "@agent-workspace/client-runtime";
import { FileIcon, SparklesIcon, SquareTerminalIcon } from "lucide-react";
import { threadExecutionSelection, usePmChatState } from "../pm/state";
import { workspaceClient } from "../network";
import { inspectUrl } from "../workspace/inspector/api";
import { useAgentText } from "../i18n";
import {
  ComposerCommandMenu,
  type ComposerMenuItem,
  type ComposerTriggerKind,
} from "./composer-command-menu";
import "./composer-suggestions.css";

type Picked = { thread: string; kind: "skill" | "command"; name: string; path: string; binding: string };
type Skill = ProviderSkillsSnapshot["skills"][number];

const TTL = 5 * 60_000;
const FILE_SEARCH_DEBOUNCE_MS = 180;

type FileSearch = {
  key: string;
  entries: InspectorSearchEntry[];
  loading: boolean;
  error?: string;
  truncated: boolean;
};

const EMPTY_FILE_SEARCH: FileSearch = { key: "", entries: [], loading: false, truncated: false };

function basenameOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator >= 0 ? path.slice(separator + 1) : path;
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : "";
}

/**
 * `@` files, `$` skills and `/` commands for the composer. The native skill
 * catalog stays scoped to the selected provider instance; file suggestions come
 * from the same server-verified execution root as the Files inspector, so the
 * composer can never reach a directory the session cannot read.
 */
export function useComposerSuggestions(instanceId: string, disabled: boolean) {
  const t = useAgentText();
  const aui = useAui();
  const state = usePmChatState();
  const localId = useAuiState((s) => s.threads.mainThreadId);
  const remoteId = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId,
  );
  const text = useAuiState((s) => s.composer.text);
  const executionSelection = threadExecutionSelection(localId, remoteId);
  const provider = state.providers.find((item) => item.instanceId === instanceId);
  const key = JSON.stringify([localId, remoteId, instanceId, provider?.revision, executionSelection]);
  const liveKey = useRef(key);
  liveKey.current = key;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const lastRequest = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    key: string;
    snapshot?: ProviderSkillsSnapshot;
    error?: string;
    loading: boolean;
  }>({ key, loading: false });
  const [cursor, setCursor] = useState(text.length);
  const [dismissed, setDismissed] = useState<string>();
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [fileSearch, setFileSearch] = useState<FileSearch>(EMPTY_FILE_SEARCH);
  const menuId = useId();
  const available =
    !!executionSelection?.agentWorkspaceId && !!provider?.nativeSessionReady && !state.providerError;
  const snapshot = result.key === key ? result.snapshot : undefined;
  const binding = snapshot ? JSON.stringify([key, snapshot.revision, snapshot.cwd]) : "";
  const current =
    available &&
    !!snapshot &&
    Date.now() - Date.parse(snapshot.checkedAt) < TTL &&
    !snapshot.error &&
    !result.error &&
    !result.loading &&
    (provider?.revision === undefined || snapshot.revision === provider.revision);
  const refresh = useCallback(
    async (fresh = true) => {
      if (
        liveKey.current !== key ||
        !available ||
        (controller.current && !controller.current.signal.aborted && Date.now() - lastRequest.current < 1000)
      )
        return;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      lastRequest.current = Date.now();
      setResult((previous) => ({
        key,
        loading: true,
        ...(previous.key === key ? { snapshot: previous.snapshot } : {}),
      }));
      try {
        const value = await workspaceClient.json<ProviderSkillsSnapshot>(
          `/api/providers/${encodeURIComponent(instanceId)}/skills/refresh`,
          {
            method: "POST",
            body: JSON.stringify({
              fresh,
              ...(remoteId ? { threadId: remoteId } : { executionSelection }),
            }),
            signal: abort.signal,
          },
        );
        if (abort.signal.aborted || liveKey.current !== key) return;
        if (value.instanceId !== instanceId)
          throw new Error(t("Skill 目录实例不匹配。", "Skill catalog instance mismatch."));
        setResult({ key, snapshot: value, loading: false });
      } catch (cause) {
        if (!abort.signal.aborted && liveKey.current === key)
          setResult((previous) => ({
            ...previous,
            key,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
      }
    },
    [available, executionSelection, instanceId, key, remoteId, t],
  );
  useEffect(() => {
    lastRequest.current = 0;
    setDismissed(undefined);
    setHighlight(0);
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
    setCursor(node.selectionStart);
    setDismissed(undefined);
    setHighlight(0);
    if (Date.now() - lastRequest.current > TTL) void refresh(false);
  };
  const trigger = !disabled && !composing.current ? detectComposerTrigger(text, cursor) : null;
  const triggerKey = trigger ? JSON.stringify([key, text, cursor]) : undefined;
  const triggerKind: ComposerTriggerKind | null =
    trigger?.kind === "path" || trigger?.kind === "skill" || trigger?.kind === "slash-command"
      ? trigger.kind
      : null;
  const visible = triggerKind !== null && dismissed !== triggerKey;
  const pathQuery = trigger?.kind === "path" ? trigger.query.trim() : null;
  const pathKey = pathQuery && remoteId ? `${remoteId}\u0000${pathQuery}` : "";
  const fileEntries = fileSearch.key === pathKey ? fileSearch.entries : [];

  useEffect(() => {
    if (!pathQuery || !remoteId) {
      setFileSearch((previous) =>
        previous.key === "" && previous.entries.length === 0 && !previous.loading && !previous.error
          ? previous
          : EMPTY_FILE_SEARCH,
      );
      return;
    }
    const abort = new AbortController();
    setFileSearch((previous) => ({
      key: pathKey,
      entries: previous.key === pathKey ? previous.entries : [],
      loading: true,
      truncated: previous.key === pathKey ? previous.truncated : false,
    }));
    const timer = window.setTimeout(() => {
      void workspaceClient
        .json<InspectorSearchResponse>(
          inspectUrl("/api/inspector/search", { q: pathQuery, threadId: remoteId }),
          { signal: abort.signal },
        )
        .then((value) => {
          if (abort.signal.aborted) return;
          setFileSearch({
            key: pathKey,
            entries: value.entries,
            loading: false,
            truncated: value.truncated,
          });
        })
        .catch((cause) => {
          if (abort.signal.aborted) return;
          setFileSearch({
            key: pathKey,
            entries: [],
            loading: false,
            truncated: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [pathKey, pathQuery, remoteId]);

  const slashSkills: Skill[] =
    current && snapshot?.invocation.skills
      ? getProviderSkillsForSlashMenu(snapshot.skills, true)
      : [];
  const fileItems: ComposerMenuItem[] =
    visible && triggerKind === "path" && pathQuery
      ? fileEntries.map((entry) => ({
          id: `file:${entry.path}`,
          type: "file" as const,
          path: entry.path,
          label: entry.name,
          description: directoryOf(entry.path),
        }))
      : [];
  const skillItems: ComposerMenuItem[] =
    current && snapshot?.invocation.skills && visible && trigger
      ? searchProviderSkills(
          trigger.kind === "slash-command" ? slashSkills : snapshot.skills,
          trigger.kind === "slash-command" ? trigger.query.replace(/^skill:/, "") : trigger.query,
          50,
        ).map((skill) => ({
          id: `skill:${skill.path}`,
          type: "skill" as const,
          skill,
          label:
            trigger.kind === "slash-command"
              ? `/skill:${skill.name}`
              : formatProviderSkillDisplayName(skill),
          description: skill.shortDescription ?? skill.description ?? "",
          value: `$${skill.name} `,
        }))
      : [];
  const commands: ComposerMenuItem[] =
    current && snapshot && !snapshot.pending && visible && trigger?.kind === "slash-command"
      ? getProviderSlashCommandsForSlashMenu(snapshot.commands, slashSkills)
          .filter(
            (command) =>
              (snapshot.invocation.commands ||
                snapshot.invocation.commandAllowlist?.includes(command.name)) &&
              !snapshot.skills.some(
                (skill) =>
                  !isProviderSkillUserInvocable(skill) &&
                  (command.name === skill.name || command.name === `skill:${skill.name}`),
              ) &&
              command.name.toLowerCase().includes(trigger.query.toLowerCase()),
          )
          .map((command) => ({
            id: `command:${command.name}`,
            type: "command" as const,
            command,
            label: `/${command.name}`,
            description: command.description ?? command.input?.hint ?? "",
            value: `/${command.name} `,
          }))
      : [];
  const items = triggerKind === "path" ? fileItems : [...skillItems, ...commands].slice(0, 60);
  const index = Math.min(highlight, Math.max(0, items.length - 1));
  const catalogStatus = !available
    ? t("先选择可用的 Provider 与作用域。", "Choose an available provider and scope first.")
    : result.key !== key || result.loading
      ? t("正在读取原生目录…", "Loading native catalog…")
      : result.error ||
        snapshot?.error?.message ||
        (!snapshot
          ? t("没有可用快照。", "No snapshot available.")
          : !current
            ? t("目录快照已过期或实例版本已改变。", "The catalog snapshot expired or its instance revision changed.")
            : snapshot.pending
              ? t(
                  "已发现的安全 Skills 可选择；命令目录尚未完整，将在同范围原生 Chat 活跃后刷新。",
                  "Discovered safe Skills are selectable. The command inventory is incomplete and refreshes when a same-scope native Chat is live.",
                )
              : !snapshot.skills.length && !snapshot.commands.length
                ? t("此原生目录为空。", "This native catalog is empty.")
                : undefined);
  const fileStatus = !remoteId
    ? t("文件引用需要已保存的代码会话。", "File references need a saved code session.")
    : !pathQuery
      ? t("输入文件名以搜索。", "Type a file name to search.")
      : fileSearch.key !== pathKey || fileSearch.loading
        ? t("正在搜索工作区文件…", "Searching workspace files…")
        : fileSearch.error
          ? fileSearch.error
          : !fileEntries.length
            ? t("没有匹配的文件。", "No matching files.")
            : undefined;
  const menuStatus = triggerKind === "path" ? fileStatus : catalogStatus;
  const menuTruncated = triggerKind === "path" && fileSearch.key === pathKey && fileSearch.truncated;

  const select = (item: ComposerMenuItem) => {
    if (!trigger || !inputRef.current || composing.current) return;
    if (item.type !== "file" && (!current || !snapshot)) return;
    const source = aui.composer.getState().text;
    if (source !== text) return;
    const end = source[trigger.rangeEnd] === " " ? trigger.rangeEnd + 1 : trigger.rangeEnd;
    const value = item.type === "file" ? `${serializeComposerFileLink(item.path)} ` : item.value;
    let edit = replaceTextRange(source, trigger.rangeStart, end, value);
    if (item.type === "skill" && snapshot && snapshot.invocation.skillSyntax === "leading-mention") {
      let body = replaceTextRange(source, trigger.rangeStart, end, "").text;
      const existing = collectComposerInlineTokens(`${body} `).find(
        (token) => token.type === "skill" && token.start === 0,
      );
      if (existing) body = body.slice(Math.min(body.length, existing.end + (body[existing.end] === " " ? 1 : 0)));
      edit = { text: `${item.value}${body}`, cursor: item.value.length };
    }
    aui.composer.setText(edit.text);
    if (item.type === "skill") {
      const choice: Picked = {
        thread: localId,
        kind: "skill",
        name: item.skill.name,
        path: item.skill.path,
        binding,
      };
      setPicked((previous) => [
        ...previous.filter(
          (pick) => pick.thread !== localId || pick.kind !== choice.kind || pick.name !== choice.name,
        ),
        choice,
      ]);
    } else if (item.type === "command") {
      const choice: Picked = {
        thread: localId,
        kind: "command",
        name: item.value.slice(1).trim(),
        path: item.id,
        binding,
      };
      setPicked((previous) => [
        ...previous.filter(
          (pick) => pick.thread !== localId || pick.kind !== choice.kind || pick.name !== choice.name,
        ),
        choice,
      ]);
    }
    setDismissed(undefined);
    setCursor(edit.cursor);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(edit.cursor, edit.cursor);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !visible
    )
      return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(triggerKey);
      return true;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      setHighlight((index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && items[index]) {
      event.preventDefault();
      select(items[index]);
      return true;
    }
    return false;
  };

  const inlineTokens = collectComposerInlineTokens(`${text} `);
  const mentionTokens: Array<{ value: string; start: number; end: number }> = inlineTokens.filter(
    (token) => token.type === "mention",
  );
  const tokens: Array<{ value: string; start: number; end: number }> = inlineTokens.filter(
    (token) => token.type === "skill",
  );
  const commandTokens = [...text.matchAll(/(^|\s)\/([^\s/]+)(?=\s|$)/g)].map((match) => ({
    name: match[2]!,
    start: match.index + match[1]!.length,
    end: match.index + match[0].length,
  }));
  const pickedCommands = picked.filter(
    (pick) =>
      pick.thread === localId &&
      pick.kind === "command" &&
      commandTokens.some((token) => token.name === pick.name),
  );
  const invalid = picked.filter(
    (pick) =>
      pick.thread === localId &&
      (pick.kind === "skill"
        ? tokens.some((token) => token.value === pick.name)
        : commandTokens.some((token) => token.name === pick.name)) &&
      (!current ||
        pick.binding !== binding ||
        (pick.kind === "skill"
          ? !snapshot?.invocation.skills ||
            !snapshot.skills.some(
              (skill) =>
                skill.path === pick.path &&
                skill.name === pick.name &&
                isProviderSkillUserInvocable(skill),
            )
          : !snapshot ||
            snapshot.pending ||
            !snapshot.commands.some(
              (command) =>
                command.name === pick.name &&
                (snapshot.invocation.commands ||
                  snapshot.invocation.commandAllowlist?.includes(command.name)),
            ))),
  );
  const remove = (name: string) => {
    const source = aui.composer.getState().text;
    const matches = collectComposerInlineTokens(`${source} `).filter(
      (token) => token.type === "skill" && token.value === name,
    );
    let next = source;
    for (const token of [...matches].reverse())
      next =
        next.slice(0, token.start) +
        next.slice(Math.min(source.length, token.end + (source[token.end] === " " ? 1 : 0)));
    aui.composer.setText(next);
    setPicked((previous) => previous.filter((pick) => pick.thread !== localId || pick.name !== name));
  };
  const removeMention = (path: string) => {
    const source = aui.composer.getState().text;
    const matches = collectComposerInlineTokens(`${source} `).filter(
      (token) => token.type === "mention" && token.value === path,
    );
    let next = source;
    for (const token of [...matches].reverse())
      next =
        next.slice(0, token.start) +
        next.slice(Math.min(source.length, token.end + (source[token.end] === " " ? 1 : 0)));
    aui.composer.setText(next);
  };
  const removeCommand = (name: string) => {
    const source = aui.composer.getState().text;
    const matches = commandTokens.filter((token) => token.name === name);
    let next = source;
    for (const token of [...matches].reverse())
      next = next.slice(0, token.start) + next.slice(token.end);
    aui.composer.setText(next);
    setPicked((previous) =>
      previous.filter(
        (pick) => pick.thread !== localId || pick.kind !== "command" || pick.name !== name,
      ),
    );
  };

  return {
    inputRef,
    onInput,
    onKeyDown,
    beforeSend: () => {
      if (invalid.length || liveKey.current !== key) return false;
      const hasSelection = picked.some(
        (pick) =>
          pick.thread === localId &&
          (pick.kind === "skill"
            ? tokens.some((token) => token.value === pick.name)
            : commandTokens.some((token) => token.name === pick.name)),
      );
      if (hasSelection && (!snapshot || Date.now() - Date.parse(snapshot.checkedAt) >= TTL)) {
        void refresh(false);
        return false;
      }
      return true;
    },
    onCompositionStart: () => {
      composing.current = true;
      setDismissed(triggerKey);
    },
    onCompositionEnd: (node: HTMLTextAreaElement) => {
      composing.current = false;
      onInput(node);
    },
    blocked: invalid.length > 0,
    inputAria: {
      "aria-controls": visible ? menuId : undefined,
      "aria-expanded": !!visible,
      "aria-activedescendant": visible && items[index] ? `${menuId}-${index}` : undefined,
      "aria-autocomplete": "list" as const,
    },
    surface: (
      <div className="composer-suggestions">
        {snapshot?.nativeConfiguration?.reloadRequired && (
          <p role="status">
            {t(
              "原生配置已变更；已安装不等于当前会话已加载。活跃执行保持不变。",
              "Native configuration changed; installed does not mean loaded in this session. Active executions are preserved.",
            )}
          </p>
        )}
        {mentionTokens.length > 0 && (
          <div className="composer-reference-chips" aria-label={t("文件引用", "File references")}>
            {mentionTokens.map((token) => (
              <button
                key={`${token.start}:${token.value}`}
                type="button"
                title={token.value}
                onClick={() => removeMention(token.value)}
              >
                <FileIcon aria-hidden="true" />
                {basenameOf(token.value)}
                <span aria-label={t("移除引用", "Remove reference")}>×</span>
              </button>
            ))}
          </div>
        )}
        {tokens.length > 0 && (
          <div className="composer-reference-chips" aria-label={t("原生 Skill 引用", "Native Skill references")}>
            {tokens.map((token) => {
              const skill =
                current && snapshot
                  ? snapshot.skills.find(
                      (candidate) =>
                        candidate.name === token.value && isProviderSkillUserInvocable(candidate),
                    )
                  : undefined;
              return (
                <button
                  key={`${token.start}:${token.value}`}
                  type="button"
                  data-invalid={invalid.some((pick) => pick.name === token.value)}
                  title={skill?.path ?? token.value}
                  onClick={() => remove(token.value)}
                >
                  <SparklesIcon aria-hidden="true" />
                  {skill ? formatProviderSkillDisplayName(skill) : `$${token.value}`}
                  <span aria-label={t("移除引用", "Remove reference")}>×</span>
                </button>
              );
            })}
          </div>
        )}
        {pickedCommands.length > 0 && (
          <div className="composer-reference-chips" aria-label={t("命令引用", "Command references")}>
            {pickedCommands.map((command) => (
              <button
                key={command.name}
                type="button"
                data-invalid={invalid.includes(command)}
                onClick={() => removeCommand(command.name)}
              >
                <SquareTerminalIcon aria-hidden="true" />/{command.name}
                <span aria-label={t("移除引用", "Remove reference")}>×</span>
              </button>
            ))}
          </div>
        )}
        {snapshot?.invocation.skillSyntax === "leading-mention" && (
          <p>
            {t(
              "此 Provider 每条消息仅原生调用开头的一个 Skill；选择会将引用放在消息最前面。",
              "This provider natively invokes only one leading Skill per message; selecting places its reference at the start.",
            )}
          </p>
        )}
        {invalid.length > 0 && (
          <p role="alert">
            {t(
              "已选 Skill 的实例、目录或作用域已变化。请移除旧引用并从当前目录重新选择后发送。",
              "A selected Skill's instance, directory or scope changed. Remove the stale reference and select from the current catalog before sending.",
            )}
          </p>
        )}
        {visible && triggerKind && (
          <ComposerCommandMenu
            listId={menuId}
            triggerKind={triggerKind}
            items={items}
            activeIndex={index}
            status={menuStatus}
            truncated={menuTruncated}
            onHighlight={setHighlight}
            onSelect={select}
          />
        )}
      </div>
    ),
  };
}
