import { useEffect, useState } from "react";
import type { GenerationOutputStatus, NativeInteractionResponse, NativeOutputItem } from "@agent-workspace/contracts/output";
import { WorkspaceClientError } from "@agent-workspace/client-runtime";
import { workspaceClient } from "../network";
import { useAgentText } from "../i18n";
import { canRespondToInteraction, isGenerationActive, isItemActive } from "./output-presenter";

export function NativeInteraction({ generationId, item, generationStatus }: { generationId: string; item: NativeOutputItem; generationStatus: GenerationOutputStatus }) {
  const t = useAgentText();
  const request = item.request;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<"answer" | "cancel">();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string>();
  const active = isItemActive(item) && isGenerationActive(generationStatus);
  useEffect(() => {
    if (!request?.respondable || !active) { setAnswers({}); setFreeText({}); }
  }, [request?.respondable, request?.id, active]);
  if (!request) return <p>{t("请求详情不可用，无法响应。", "Request details unavailable; cannot respond.")}</p>;
  const enabled = canRespondToInteraction(item, generationStatus) && !submitted && !closed;
  const submit = async (response: NativeInteractionResponse) => {
    if (!enabled || pending) return;
    setPending(true); setError(undefined);
    try {
      await workspaceClient.json(`/api/chat/generations/${encodeURIComponent(generationId)}/requests/${encodeURIComponent(request.id)}/respond`, { method: "POST", body: JSON.stringify(response) });
      setAnswers({}); setFreeText({}); setSubmitted(response.cancelled ? "cancel" : "answer");
    } catch (cause) {
      if (cause instanceof WorkspaceClientError && cause.code === "native_interaction_closed") { setAnswers({}); setFreeText({}); setClosed(true); }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  };
  return <div className="native-interaction">
    {request.detail && <p>{request.detail}</p>}
    {!enabled && <p role="status">{submitted === "cancel" ? t("已取消回答，等待运行继续。", "Response cancelled; waiting for the run to continue.") : submitted === "answer" ? t("响应已提交，等待运行继续。", "Response submitted; waiting for the run to continue.") : request.unavailableReason || (closed || request.respondable ? t("请求已结束或过期，无法响应。", "This request has ended or expired and cannot be answered.") : t("当前请求不可响应。", "This request cannot be answered."))}</p>}
    {request.kind === "approval" && <div className="native-buttons">{request.options?.map(option => <button key={option.id} type="button" disabled={!enabled || pending} title={option.description} onClick={() => void submit({ optionId: option.id })}>{option.label}</button>)}</div>}
    {request.kind === "user_input" && <form onSubmit={event => {
      event.preventDefault();
      const combined = { ...answers };
      for (const question of request.questions ?? []) {
        const text = freeText[question.id]?.trim();
        if (text) combined[question.id] = question.multiple ? [...(Array.isArray(combined[question.id]) ? combined[question.id] as string[] : []), text] : text;
      }
      void submit({ answers: combined });
    }}>
      {request.questions?.map(question => <fieldset key={question.id} disabled={!enabled || pending}>
        <legend>{question.title || question.prompt}</legend>{question.title && <p>{question.prompt}</p>}
        {question.options?.map(option => <label key={option.id} className="native-option">
          <input type={question.multiple ? "checkbox" : "radio"} name={`${request.id}:${question.id}`} value={option.id} checked={question.multiple ? Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(option.id) : answers[question.id] === option.id} onChange={event => {
            if (!question.multiple) setFreeText(previous => ({ ...previous, [question.id]: "" }));
            setAnswers(previous => ({ ...previous, [question.id]: question.multiple ? event.target.checked ? [...(Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []), option.id] : (Array.isArray(previous[question.id]) ? previous[question.id] as string[] : []).filter(id => id !== option.id) : option.id }));
          }} /> <span>{option.label}{option.description && <small>{option.description}</small>}</span>
        </label>)}
        {(question.allowText || !question.options?.length) && <input className="native-text-input" type={question.secret ? "password" : "text"} autoComplete="off" aria-label={question.prompt} placeholder={t("输入回答", "Type your answer")} value={freeText[question.id] ?? ""} onChange={event => {
          const value = event.target.value;
          setFreeText(previous => ({ ...previous, [question.id]: value }));
          if (!question.multiple && value) setAnswers(previous => ({ ...previous, [question.id]: "" }));
        }} />}
      </fieldset>)}
      <button type="submit" disabled={!enabled || pending || !request.questions?.length || request.questions.some(question => !freeText[question.id]?.trim() && (!answers[question.id] || (Array.isArray(answers[question.id]) && !(answers[question.id] as string[]).length)))}>{pending ? t("提交中…", "Submitting…") : t("提交回答", "Submit answer")}</button>
      <button type="button" disabled={!enabled || pending} onClick={() => void submit({ cancelled: true })}>{t("取消回答", "Cancel answer")}</button>
    </form>}
    {error && <p role="alert">{t("响应未提交：", "Response not submitted: ")}{error}</p>}
  </div>;
}
