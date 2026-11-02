// Native workflow adapters for the pinned MIT-licensed OpenHands extensions bundles.
// Source provenance/license: vendor/openhands-automations/source-pin.json and LICENSE.extensions.
import type { NativeTemplateHandler, NativeTemplateId } from './ports.ts';
import { parseArguments } from './github-agent-common.ts';
import { issueToPr } from './github-agent-implementation.ts';
import { issueTriage } from './github-agent-triage.ts';
import { prReviewer } from './github-agent-review.ts';

/** Source-form argument admission; secret names are never credential lookup authority. */
export function validateGithubAgentArguments(templateId: NativeTemplateId, arguments_: Readonly<Record<string, unknown>>): void {
  parseArguments(templateId, arguments_);
}
export const githubAgentHandlers: Partial<Record<NativeTemplateId, NativeTemplateHandler>> = {
  'github-issue-to-pr': issueToPr,
  'github-issue-triage': issueTriage,
  'github-pr-reviewer': prReviewer,
};
