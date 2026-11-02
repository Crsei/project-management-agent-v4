import { z } from 'zod';
import {
  pmAutomationApplyRequestSchema, pmAutomationCandidateEditSchema, pmAutomationCandidatePreviewSchema, pmAutomationEventSchema,
  pmAutomationPreviewRequestSchema, pmAutomationPublishSchema, pmAutomationResultSchema,
  pmAutomationReviewReceiptSchema, pmAutomationReviewRequestSchema,
  pmAutomationSnapshotInputSchema, pmAutomationSnapshotSchema, pmAutomationVisitRequestSchema,
} from './automation-pm.ts';

/** PM-native analysis is run-bound; only a current human session may apply candidates. */
export function automationPmPaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const execution = { name: 'executionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const candidate = { name: 'candidateId', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 300 } };
  const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema) } });
  const endpoint = (operationId: string, description: string, output: z.ZodType, parameters: unknown[], input?: z.ZodType, serviceOnly = false) => ({
    operationId, description,
    security: serviceOnly ? [{ automationExecutionBearer: [] }] : [{ sessionCookie: [] }, { bearerAuth: [] }],
    parameters: [workspace, ...parameters],
    ...(input ? { requestBody: { required: true, content: json(input) } } : {}),
    responses: {
      200: { description: 'Authorized result. Analysis success does not change a task or approve delivery.', content: json(output) },
      ...Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 503].map(status => [status, { description: 'Invalid input, unavailable source, authorization or revision conflict. An uncertain mutation must be reconciled with its original requestId; never submit a replacement operation.' }])),
    },
  });
  const base = '/api/v1/workspaces/{workspaceId}/automations/pm';
  const run = base + '/executions/{executionId}';
  const item = run + '/candidates/{candidateId}';
  return {
    [run + '/snapshot']: {
      get: endpoint('getPmAutomationSnapshot', 'Read the immutable authorized source snapshot for the original execution, including source revisions, time boundaries and incomplete coverage. Does not read or initialize unrelated project data.', pmAutomationSnapshotSchema, [execution]),
      post: endpoint('capturePmAutomationSnapshot', 'Original active execution service identity only. Capture authorized PM facts and validated Agent evidence once; repeating the same frozen identity does not replace input or grant business write authority.', pmAutomationSnapshotSchema, [execution], pmAutomationSnapshotInputSchema, true),
    },
    [run + '/result']: {
      get: endpoint('getPmAutomationResult', 'Read source-linked findings and current candidate review states. Missing evidence is not a successful verification.', pmAutomationResultSchema, [execution]),
      post: endpoint('publishPmAutomationResult', 'Original active execution service identity only. Publish validated source-bound findings and pending candidates idempotently. Cannot apply candidates, create business objects or change workflow states.', pmAutomationResultSchema, [execution], pmAutomationPublishSchema, true),
    },
    [item]: { patch: endpoint('editPmAutomationCandidate', 'Explicitly edit allowed proposal fields at the current candidate revision. Source identities and scope cannot be replaced. No business object is written.', pmAutomationReviewReceiptSchema, [execution, candidate], pmAutomationCandidateEditSchema) },
    [item + '/preview']: { post: endpoint('previewPmAutomationCandidate', 'Recheck current source revisions and authority, validate selected plan items and dependency closure, and return an apply token. Preview does not execute business commands.', pmAutomationCandidatePreviewSchema, [execution, candidate], pmAutomationPreviewRequestSchema) },
    [item + '/apply']: { post: endpoint('applyPmAutomationCandidate', 'Human session only. Apply the explicitly previewed candidate through existing PM services with current authorization, revision guards and durable original operation identities. Preserve plan item to real entity ID mapping; partial or unknown results never authorize fresh-ID replay. Explicit continuation keeps the exact original requestId and approved input.', pmAutomationReviewReceiptSchema, [execution, candidate], pmAutomationApplyRequestSchema) },
    [item + '/ignore']: { post: endpoint('ignorePmAutomationCandidate', 'Record the current actor decision at the expected candidate revision. Does not apply the proposed business change.', pmAutomationReviewReceiptSchema, [execution, candidate], pmAutomationReviewRequestSchema) },
    [base + '/receipts/{requestId}']: { get: endpoint('getPmAutomationReceipt', 'Read the original review mutation receipt after uncertain transport. Current actor and project authorization are rechecked; reading never resumes writes.', pmAutomationReviewReceiptSchema, [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]) },
    [base + '/visits']: { post: endpoint('recordPmAutomationVisit', 'Human session only. Record an actual project navigation with the server clock and retain the original visit interval under requestId. First visit has no fabricated prior boundary; replay never widens the window.', pmAutomationEventSchema, [], pmAutomationVisitRequestSchema) },
    [base + '/signals']: { post: {
      ...endpoint('receivePmAutomationSignal', 'Internal Agent producer only. Verify the timestamp and HMAC over the exact request method, path and raw JSON bytes before accepting a terminal run or idle-session event. User cookies and execution bearer tokens cannot authorize this ingress; duplicate event identity is idempotent.',
        z.strictObject({ eventId: pmAutomationEventSchema.shape.eventId, accepted: z.boolean() }), [], pmAutomationEventSchema),
      security: [{ automationSignalSignature: [], automationSignalTimestamp: [] }],
    } },
  };
}
