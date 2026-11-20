import { useEffect, useId, useRef, useState } from "react";
import { PlayIcon, RefreshCwIcon, TerminalSquareIcon } from "lucide-react";
import type { InspectorFileResponse } from "@agent-workspace/contracts/inspector";
import styles from "./thread-details-sections.module.css";
import { useAgentText, type AgentText } from "../i18n";
import { inspectUrl, errorMessage } from "../workspace/inspector/api";
import { workspaceClient } from "../network";
import {
  requestTerminalRun,
  TERMINAL_RUN_RESULT_EVENT,
  useTerminalRunAvailable,
  type TerminalRunResult,
} from "../chat/terminal-run";
import { readProjectScripts, type ProjectScript, type ProjectScripts } from "./thread-project-scripts";

type Failure = { message: string; code?: string };

type Load =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "truncated" }
  | { status: "failure"; failure: Failure }
  | { status: "parsed"; result: ProjectScripts };

type RunState = {
  command: string;
  requestId?: string;
  ok?: boolean;
  message?: string;
};

function failureOf(error: unknown): Failure {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  return { message: errorMessage(error), ...(code ? { code } : {}) };
}

function isTerminalRunResult(value: unknown): value is TerminalRunResult {
  return value !== null && typeof value === "object"
    && "requestId" in value && typeof value.requestId === "string"
    && "ok" in value && typeof value.ok === "boolean"
    && (!("message" in value) || value.message === undefined || typeof value.message === "string");
}

function invalidScriptsText(result: ProjectScripts, t: AgentText): string {
  if (result.status !== "invalid") return "";
  return result.reason === "invalid_json"
    ? t("package.json 不是有效 JSON。", "package.json is not valid JSON.")
    : t("package.json 的 scripts 字段不是对象。", "The package.json scripts field is not an object.");
}

export function ThreadProjectScriptsSection({
  threadId,
  environmentPath,
}: {
  threadId: string;
  environmentPath?: string;
}) {
  const t = useAgentText();
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [run, setRun] = useState<RunState>();
  const terminalAvailable = useTerminalRunAvailable();
  const sequence = useRef(0);
  const runPending = run?.requestId !== undefined && run.ok === undefined;

  useEffect(() => {
    if (!environmentPath) {
      setLoad({ status: "missing" });
      return;
    }
    const id = ++sequence.current;
    const controller = new AbortController();
    setLoad({ status: "loading" });
    void workspaceClient.json<InspectorFileResponse>(
      inspectUrl("/api/inspector/file", { threadId, path: "package.json" }),
      { signal: controller.signal, cache: "no-store" },
    ).then(file => {
      if (controller.signal.aborted || sequence.current !== id) return;
      if (file.truncated) {
        setLoad({ status: "truncated" });
        return;
      }
      setLoad({ status: "parsed", result: readProjectScripts(file.content) });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence.current !== id) return;
      const failure = failureOf(error);
      if (failure.code === "not_found") setLoad({ status: "missing" });
      else setLoad({ status: "failure", failure });
    });
    return () => controller.abort();
    // The directory is part of the key: switching worktrees must never reuse an old package.
  }, [threadId, environmentPath, reload]);

  useEffect(() => {
    const requestId = run?.requestId;
    if (!requestId) return;
    const handle = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isTerminalRunResult(detail) || detail.requestId !== requestId) return;
      setRun(current => current?.requestId === requestId
        ? { ...current, ok: detail.ok, message: detail.message }
        : current);
    };
    window.addEventListener(TERMINAL_RUN_RESULT_EVENT, handle);
    const timer = window.setTimeout(() => {
      setRun(current => current?.requestId === requestId && current.ok === undefined
        ? { ...current, ok: false, message: t("终端尚未确认执行结果，请核对终端面板。", "The terminal has not confirmed the result yet. Check the terminal panel.") }
        : current);
    }, 12_000);
    return () => {
      window.removeEventListener(TERMINAL_RUN_RESULT_EVENT, handle);
      window.clearTimeout(timer);
    };
  }, [run?.requestId, t]);

  const runScript = (script: ProjectScript) => {
    const requestId = requestTerminalRun(script.command);
    if (!requestId) {
      setRun({ command: script.command, ok: false, message: t("当前视图未启用终端，命令未发送。", "Terminals are not enabled in this view; the command was not sent.") });
      return;
    }
    setRun({ command: script.command, requestId });
  };

  const renderFailure = (failure: Failure) => (
    <p role="alert" className={styles.error}>
      {failure.message}
      {failure.code && <> <code className={styles.code}>{failure.code}</code></>}
    </p>
  );

  return <section className={styles.section} aria-labelledby={headingId}>
    <div className={styles.sectionHeader}>
      <h3 id={headingId} className={styles.title}>{t("项目脚本", "Project scripts")}</h3>
      <button type="button" className={styles.button} onClick={() => setReload(value => value + 1)}>
        <RefreshCwIcon aria-hidden="true" />{t("重新读取", "Reload")}
      </button>
    </div>
    {load.status === "loading" && <p role="status" className={styles.note}>{t("正在读取执行目录的 package.json…", "Reading package.json from the execution folder…")}</p>}
    {load.status === "missing" && <p className={styles.note}>{t("执行目录没有可读取的 package.json。", "The execution folder has no readable package.json.")}</p>}
    {load.status === "truncated" && <p role="alert" className={styles.error}>{t("package.json 超过读取上限，未完整读取；不会解析或缓存部分内容。", "package.json exceeds the read limit, so it was not read completely; no partial content is parsed or cached.")}</p>}
    {load.status === "failure" && renderFailure(load.failure)}
    {load.status === "parsed" && load.result.status === "invalid" && <p role="alert" className={styles.error}>{invalidScriptsText(load.result, t)}</p>}
    {load.status === "parsed" && load.result.status === "no_scripts" && <p className={styles.note}>{t("package.json 中没有 scripts。", "package.json has no scripts.")}</p>}
    {load.status === "parsed" && load.result.status === "ready" && <>
      <p className={styles.subtitle}>{t(`包管理器：${load.result.manager}`, `Package manager: ${load.result.manager}`)}</p>
      <ul className={styles.list}>
        {load.result.scripts.map(script => <li key={script.name} className={styles.scriptRow}>
          <span className={styles.scriptName} title={script.command}>{script.name}</span>
          {terminalAvailable && <button type="button" className={styles.button} disabled={runPending} title={t(`在会话终端运行：${script.command}`, `Run in the Session terminal: ${script.command}`)} onClick={() => runScript(script)}>
            <PlayIcon aria-hidden="true" />{t("在终端运行", "Run in terminal")}
          </button>}
        </li>)}
      </ul>
      {!terminalAvailable && <p className={styles.note}>{t("当前视图未启用终端，运行按钮已隐藏。", "Terminals are not enabled in this view, so run buttons are hidden.")}</p>}
    </>}
    {run && <div className={styles.confirm}>
      <p className={styles.subtitle}><TerminalSquareIcon aria-hidden="true" /> <code className={styles.code}>{run.command}</code></p>
      {run.requestId === undefined ? <p role="alert" className={styles.error}>{run.message}</p>
        : run.ok === undefined ? <p role="status" className={styles.note}>{t("正在写入会话终端…", "Writing to the Session terminal…")}</p>
        : run.ok ? <p role="status" className={styles.note}>{t("命令已写入会话终端。", "The command was written to the Session terminal.")}</p>
        : <p role="alert" className={styles.error}>{run.message || t("终端未确认命令写入。", "The terminal did not confirm the command.")}</p>}
    </div>}
  </section>;
}
