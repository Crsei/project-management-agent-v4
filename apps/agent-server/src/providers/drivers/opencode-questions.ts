// Protocol shapes follow OpenCode SDK 1.x and @opencode/schema 2.0.28.
// Form mapping adapted from t3code. Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { NativeInteractionRequest, NativeInteractionResponse } from "@agent-workspace/contracts/output";
import { array, object, string, type OpenCodeGeneration } from "./opencode-transport.ts";

type Question = NonNullable<NativeInteractionRequest["questions"]>[number];
export type OpenCodeQuestion = { request: NativeInteractionRequest; fields: Record<string, unknown>[] };

export function openCodeQuestion(version: OpenCodeGeneration, properties: Record<string, unknown>): OpenCodeQuestion | undefined {
  const v2 = version === "v2";
  const form = object(properties.form);
  if (v2 && object(form.metadata).kind !== "question") return undefined;
  const id = string(v2 ? form.id : properties.id);
  const fields = array(v2 ? form.fields : properties.questions);
  if (!id || !fields.length) return undefined;
  const questions: Question[] = [];
  for (const [index, field] of fields.entries()) {
    if (v2 && (field.type !== "string" && field.type !== "multiselect" || field.hidden === true || (Array.isArray(field.when) && field.when.length))) return undefined;
    const questionId = v2 ? string(field.key) : `q${index}`;
    const prompt = string(v2 ? field.description : field.question) || string(field.title);
    if (!questionId || !prompt || questions.some((question) => question.id === questionId)) return undefined;
    const options = array(field.options).map((option) => ({ id: string(v2 ? option.value : option.label), label: string(option.label), ...(string(option.description) ? { description: string(option.description) } : {}) }));
    if (options.some((option) => !option.id || !option.label) || new Set(options.map((option) => option.id)).size !== options.length) return undefined;
    const title = string(v2 ? field.title : field.header);
    questions.push({ id: questionId, prompt, ...(title ? { title } : {}), ...(options.length ? { options } : {}),
      multiple: v2 ? field.type === "multiselect" : field.multiple === true,
      allowText: field.custom === true || options.length === 0 });
  }
  const itemId = `opencode:question:${id}`;
  return { fields, request: { id, itemId, kind: "user_input", title: string(form.title) || "User input requested", questions, respondable: true } };
}

/** Reject malformed consumer responses before they reach either native protocol. */
export function openCodeQuestionAnswer(question: OpenCodeQuestion, response: NativeInteractionResponse, version: OpenCodeGeneration): unknown {
  if (response.cancelled) {
    if (response.answers !== undefined || response.optionId !== undefined) throw new Error("Invalid OpenCode question cancellation.");
    return undefined;
  }
  const answers = response.answers;
  const questions = question.request.questions!;
  if (!answers || response.optionId !== undefined || Object.keys(answers).some((key) => !questions.some((entry) => entry.id === key))) throw new Error("Invalid OpenCode question answer.");
  const mapped: Record<string, string | string[]> = {};
  const ordered: string[][] = [];
  for (const [index, entry] of questions.entries()) {
    const raw = answers[entry.id];
    const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    if (!values.length || (!entry.multiple && values.length !== 1) || values.some((value) => typeof value !== "string" || !value || (entry.options?.length && !entry.allowText && !entry.options.some((option) => option.id === value)))) throw new Error("Invalid OpenCode question answer.");
    const field = question.fields[index]!;
    if (typeof field.minItems === "number" && values.length < field.minItems || typeof field.maxItems === "number" && values.length > field.maxItems) throw new Error("Invalid OpenCode question answer.");
    if (values.some((value) => typeof field.minLength === "number" && value.length < field.minLength || typeof field.maxLength === "number" && value.length > field.maxLength || typeof field.pattern === "string" && !new RegExp(field.pattern).test(value))) throw new Error("Invalid OpenCode question answer.");
    ordered.push(values);
    mapped[entry.id] = entry.multiple ? values : values[0]!;
  }
  return version === "v2" ? { answer: mapped } : { answers: ordered };
}
