import { pmAutomationTemplateIds, pmAutomationArgumentsSchema, type PmAutomationTemplateId } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { evaluatePmAutomation } from './pm-analysis.ts';
import { preparedPmAutomationResult } from './pm-bridge.ts';
import { NativeTemplateUnknownOutcome, type NativeTemplateContext, type NativeTemplateHandler } from './ports.ts';

const runPmAutomation: NativeTemplateHandler = async (context: NativeTemplateContext) => {
  if (!context.pm) throw new Error('Authorized PM snapshot/result bridge is unavailable.');
  const snapshot = await context.pm.snapshot();
  context.signal.throwIfAborted();
  const threads: string[] = [];
  const result = preparedPmAutomationResult(context.request) ?? await evaluatePmAutomation(snapshot, pmAutomationArgumentsSchema.parse(context.arguments), {
    analyze: async input => {
      const agent = await context.runAgent({ key: `pm-analysis:${context.request.executionId}:${input.key}`, analysisSkill: input.skill, prompt: input.prompt });
      threads.push(agent.threadId);
      if (agent.status === 'outcome_unknown') throw new NativeTemplateUnknownOutcome('The original read-only analysis generation is unconfirmed; it is not redispatched with a fresh identity.');
      if (agent.status !== 'completed') throw new Error('Read-only analysis Provider generation failed.');
      return agent.text;
    },
  });
  context.signal.throwIfAborted();
  await context.pm.publish(result);
  return { summary: result.summary, threadIds: threads, details: { templateId: result.templateId, executionId: result.executionId, findings: result.findings.length, candidates: result.candidates.length, coverage: result.coverage, gaps: result.gaps, persistenceBoundary: 'pm-result-and-agent-chat', taskStateChanged: false } };
};
export const pmAutomationHandlers: Record<PmAutomationTemplateId, NativeTemplateHandler> = Object.fromEntries(pmAutomationTemplateIds.map(id => [id, runPmAutomation])) as Record<PmAutomationTemplateId, NativeTemplateHandler>;
