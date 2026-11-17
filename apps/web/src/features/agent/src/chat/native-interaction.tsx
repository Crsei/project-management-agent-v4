import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { GenerationOutputStatus, NativeInteractionResponse, NativeOutputItem } from "@agent-workspace/contracts/output";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { useI18n } from "@/lib/i18n-provider";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { Markdown } from "./markdown";
import { clampIndex, isInteractionComplete, isQuestionAnswered } from "./native-interaction-model";
import { canRespondToInteraction, isGenerationActive, isItemActive } from "./output-presenter";

export function NativeInteraction({ generationId, item, generationStatus }: { generationId: string; item: NativeOutputItem; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const { locale } = useI18n();
  const request = item.request;
  const questions = request?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<"answer" | "cancel">();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const advanceTimer = useRef<number | undefined>(undefined);
  const active = isItemActive(item) && isGenerationActive(generationStatus);
  const index = clampIndex(questionIndex, questions.length);
  const current = questions[index];
  useEffect(() => {
    if (!request?.respondable || !active) { setAnswers({}); setFreeText({}); }
  }, [request?.respondable, request?.id, active]);
  useEffect(() => { setQuestionIndex(0); setSubmitted(undefined); setClosed(false); setError(undefined); }, [request?.id]);
  useEffect(() => () => { if (advanceTimer.current) window.clearTimeout(advanceTimer.current); }, []);
  const enabled = canRespondToInteraction(item, generationStatus) && !submitted && !closed;
  const complete = isInteractionComplete(questions, answers, freeText);
  const submit = async (response: NativeInteractionResponse) => {
    if (!request || !enabled || pending) return;
    setPending(true); setError(undefined);
    try {
      await workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/requests/${encodeURIComponent(request.id)}/respond`, { method: "POST", body: JSON.stringify(response) });
      setAnswers({}); setFreeText({}); setSubmitted(response.cancelled ? "cancel" : "answer");
    } catch (cause) {
      if (cause instanceof WorkspaceClientError && cause.code === "native_interaction_closed") { setAnswers({}); setFreeText({}); setClosed(true); }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  };
  const goTo = useCallback((next: number) => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = undefined;
    setQuestionIndex(clampIndex(next, questions.length));
  }, [questions.length]);
  const selectOption = useCallback((optionId: string) => {
    if (!enabled || !current) return;
    if (current.multiple) {
      setAnswers(previous => {
        const existing = Array.isArray(previous[current.id]) ? previous[current.id] as string[] : [];
        return { ...previous, [current.id]: existing.includes(optionId) ? existing.filter(id => id !== optionId) : [...existing, optionId] };
      });
      return;
    }
    setFreeText(previous => ({ ...previous, [current.id]: "" }));
    setAnswers(previous => ({ ...previous, [current.id]: optionId }));
    // Keep the provider's question order; advance only when another question remains.
    if (index < questions.length - 1) {
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => {
        advanceTimer.current = undefined;
        setQuestionIndex(value => clampIndex(value + 1, questions.length));
      }, 200);
    }
  }, [enabled, current, index, questions.length]);
  useEffect(() => {
    if (!enabled || !current) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = current.options?.[digit - 1];
      if (!option) return;
      event.preventDefault();
      selectOption(option.id);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, current, selectOption]);
  if (!request) return <p>{t("请求详情不可用，无法响应。", "Request details unavailable; cannot respond.")}</p>;
  const fieldset = current && <fieldset key={current.id} disabled={!enabled || pending}>
    <legend>{current.title || t("需要回答", "Input needed")}</legend>
    <div className="native-question-prompt"><Markdown content={current.prompt} locale={locale === "en" ? "en" : "zh-CN"} /></div>
    {current.options?.length ? <div className="native-question-options" role={current.multiple ? "group" : "radiogroup"} aria-label={current.title || current.prompt}>
      {current.options.map((option, optionIndex) => {
        const selected = current.multiple
          ? Array.isArray(answers[current.id]) && (answers[current.id] as string[]).includes(option.id)
          : answers[current.id] === option.id;
        return <button key={option.id} type="button" className="native-question-option" data-selected={selected || undefined}
          role={current.multiple ? "checkbox" : "radio"} aria-checked={selected}
          disabled={!enabled || pending} onClick={() => selectOption(option.id)}>
          {optionIndex < 9 && <span className="native-option-key" aria-hidden="true">{optionIndex + 1}</span>}
          <span className="native-option-label">{option.label}{option.description && <small>{option.description}</small>}</span>
          {selected && <Check aria-hidden="true" className="native-option-check" />}
        </button>;
      })}
    </div> : null}
    {(current.allowText || !current.options?.length) && <input className="native-text-input" type={current.secret ? "password" : "text"} autoComplete="off" aria-label={current.prompt} placeholder={t("输入回答", "Type your answer")} value={freeText[current.id] ?? ""} onChange={event => {
      const value = event.target.value;
      setFreeText(previous => ({ ...previous, [current.id]: value }));
      if (!current.multiple && value) setAnswers(previous => ({ ...previous, [current.id]: "" }));
    }} />}
  </fieldset>;
  return <div className="native-interaction">
    {request.detail && <p className="native-request-detail">{request.detail}</p>}
    {!enabled && <p role="status">{submitted === "cancel" ? t("已取消回答，等待运行继续。", "Response cancelled; waiting for the run to continue.") : submitted === "answer" ? t("响应已提交，等待运行继续。", "Response submitted; waiting for the run to continue.") : request.unavailableReason || (closed || request.respondable ? t("请求已结束或过期，无法响应。", "This request has ended or expired and cannot be answered.") : t("当前请求不可响应。", "This request cannot be answered."))}</p>}
    {request.kind === "approval" && <div className="native-buttons">{request.options?.map(option => <button key={option.id} type="button" disabled={!enabled || pending} title={option.description} onClick={() => void submit({ optionId: option.id })}>{option.label}</button>)}</div>}
    {request.kind === "user_input" && <form onSubmit={event => {
      event.preventDefault();
      const combined = { ...answers };
      for (const question of questions) {
        const text = freeText[question.id]?.trim();
        if (text) combined[question.id] = question.multiple ? [...(Array.isArray(combined[question.id]) ? combined[question.id] as string[] : []), text] : text;
      }
      void submit({ answers: combined });
    }}>
      {questions.length > 1 && <nav className="native-question-progress" aria-label={t("问题导航", "Question navigation")}>
        <button type="button" disabled={index === 0 || pending} aria-label={t("上一题", "Previous question")} onClick={() => goTo(index - 1)}><ChevronLeft aria-hidden="true" /></button>
        <span>{t(`问题 ${index + 1}/${questions.length}`, `Question ${index + 1} of ${questions.length}`)}</span>
        <button type="button" disabled={index >= questions.length - 1 || pending} aria-label={t("下一题", "Next question")} onClick={() => goTo(index + 1)}><ChevronRight aria-hidden="true" /></button>
      </nav>}
      {fieldset}
      <div className="native-interaction-actions">
        {index < questions.length - 1
          ? <button type="button" disabled={!enabled || pending || !current || !isQuestionAnswered(current, answers, freeText)} onClick={() => goTo(index + 1)}>{t("下一题", "Next question")}</button>
          : <button type="submit" disabled={!enabled || pending || !complete}>{pending ? t("提交中…", "Submitting…") : t("提交回答", "Submit answer")}</button>}
        <button type="button" disabled={!enabled || pending} onClick={() => void submit({ cancelled: true })}>{t("取消回答", "Cancel answer")}</button>
      </div>
    </form>}
    {error && <p role="alert">{t("响应未提交：", "Response not submitted: ")}{error}</p>}
  </div>;
}
