import type { NativeInteractionRequest } from "@agent-workspace/contracts/output";

type Question = NonNullable<NativeInteractionRequest["questions"]>[number];
type AnswerMap = Record<string, string | string[]>;
type TextMap = Record<string, string>;

export function isQuestionAnswered(question: Question, answers: AnswerMap, freeText: TextMap): boolean {
  if (freeText[question.id]?.trim()) return true;
  const answer = answers[question.id];
  return Array.isArray(answer) ? answer.length > 0 : typeof answer === "string" && answer.length > 0;
}

/** The provider decides which questions exist; the UI only checks that each has an answer. */
export function isInteractionComplete(questions: readonly Question[] | undefined, answers: AnswerMap, freeText: TextMap): boolean {
  return !!questions?.length && questions.every(question => isQuestionAnswered(question, answers, freeText));
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}
