import type { CliObservationSummary } from '../runners/cli-observations.ts';

function cell(value: string | number | boolean | null): string {
  if (value === null) return 'unknown';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`|*_[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');
}
function references(ids: readonly string[]): string { return ids.length ? ids.map(cell).join(', ') : 'none observed'; }

/** Renders product projection evidence, never a substitute success grade or Provider-wire report. */
export function renderCliObservationReport(summary: CliObservationSummary): string {
  const { counts, cliTiming } = summary;
  const lines = [
    '# CLI observation report', '',
    'Product CLI projections only. Independent task grades and broker wire/model evidence remain authoritative for their own dimensions.', '',
    `Collection events: ${counts.events}; observed: ${counts.observed}; unavailable: ${counts.unavailable}; invalid: ${counts.invalid}; repeated snapshots: ${counts.duplicateSnapshots}.`,
    'No task-success, exact-prompt, model-read or billing conclusion is derived here.', '',
    '## Source and collection provenance', '',
    '| Run | Product source SHA256 | Manifest version | CLI SHA256 | Source event IDs |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const source of summary.sourceVersions) lines.push(`| ${cell(source.runId)} | ${cell(source.version.sourceHash)} | ${cell(source.version.manifestVersion)} | ${cell(source.version.cliSha256)} | ${references(source.eventIds)} |`);
  if (!summary.sourceVersions.length) lines.push('| unknown | unknown | unknown | unknown | none observed |');
  lines.push('', '## Individual observations', '',
    '| Event ID / run | Kind / collector | Collection / identity | Requested Session / generation / input | Returned Session / generation / input / output | Duplicate snapshot of | Limitations / error |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of summary.observations) {
    const requested = [row.requested.sessionId, row.requested.generationId, row.requested.messageId].map(cell).join(' / ');
    const returned = row.identities.length ? row.identities.map(id => [id.sessionId, id.generationId, id.inputMessageId, id.outputMessageId].map(cell).join(' / ')).join('; ') : 'unknown';
    const issues = [...row.issues, ...(row.error ? [row.error] : [])];
    lines.push(`| ${cell(row.eventId)} / ${cell(row.runId)} | ${cell(row.kind)} / ${cell(row.source)} | ${cell(row.collectionStatus)} / ${cell(row.identityStatus)} | ${requested} | ${returned} | ${cell(row.duplicateOfEventId)} | ${issues.length ? issues.map(cell).join('; ') : 'none recorded'} |`);
  }
  if (!summary.observations.length) lines.push('| none observed | unknown | unknown | unknown | unknown | unknown | CLI collection may not have reached an authenticated Session. |');
  lines.push('', '### Projected metadata (not PM bodies or a reconstructed prompt)', '');
  for (const row of summary.observations) {
    const detail: string[] = [];
    if (row.sessionRevision !== null) detail.push(`Session revision ${cell(row.sessionRevision)}`);
    if (row.execution) detail.push(`execution workspace ${cell(row.execution.agentWorkspaceId)} revision ${cell(row.execution.agentWorkspaceRevision)}, frozen ${cell(row.execution.frozen)}; response does not independently echo the Session`);
    if (row.generationStatus) detail.push(`generation status ${cell(row.generationStatus)} (not a task grade)`);
    if (row.output) detail.push(`native output sequences ${references(row.output.sequences.map(String))}; statuses ${references(row.output.statuses)}; ${cell(row.output.itemCount)} distinct item snapshots, outputTruncated=true ${cell(row.output.truncatedItems)}, false ${cell(row.output.explicitUntruncatedItems)}, unspecified ${cell(row.output.truncationUnknownItems)}`);
    for (const context of row.contexts) {
      detail.push(`TurnContext version ${cell(context.version)}, acceptedAt ${cell(context.acceptedAt)}, visibility ${cell(context.visibility)}; PM body/truncation not projected`);
      if (context.pmReferences === null) detail.push('reference metadata unknown');
      else if (!context.pmReferences.length) detail.push('explicitly empty reference metadata');
      else for (const ref of context.pmReferences) detail.push(`reference ${cell(ref.workspaceId)} / ${cell(ref.kind)} / ${cell(ref.projectId)} / ${cell(ref.id)} revision ${cell(ref.revision)}, availability ${cell(ref.availability)}${ref.reason ? `, reason ${cell(ref.reason)}` : ''}`);
    }
    if (detail.length) lines.push(`- ${cell(row.eventId)}: ${detail.join('; ')}.`);
  }
  if (!summary.observations.some(row => row.contexts.length || row.execution || row.output || row.sessionRevision !== null || row.generationStatus)) lines.push('No product metadata observed.');
  lines.push('', '## Session / generation / input-message correlation', '',
    '| Run / Session / generation | Input / output message | Session events | Generation events | Context events | Output / usage events | Limitations |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const link of summary.correlations) lines.push(`| ${cell(link.runId)} / ${cell(link.sessionId)} / ${cell(link.generationId)} | ${cell(link.inputMessageId)} / ${cell(link.outputMessageId)} | ${references(link.sessionEventIds)} | ${references(link.generationEventIds)} | ${references(link.contextEventIds)} | ${references(link.outputEventIds)} / ${references(link.usageEventIds)} | ${link.issues.length ? link.issues.map(cell).join('; ') : 'none recorded'} |`);
  if (!summary.correlations.length) lines.push('| none independently linked | unknown | none observed | none observed | none observed | none observed | Missing or mismatched identities remain unknown. |');
  lines.push('', '## Product usage projections (not broker usage or billing)', '',
    'One selected snapshot per run/Session/generation; repeated snapshots are not added. Distinct generations are not summed because native-turn overlap is not established. Product categories, reportedTurn and context-window occupancy are separate dimensions.', '',
    '| Run / Session / generation | Selection / event IDs | Product totals: uncached input / cached input / cache creation / output / reasoning | Product estimated cost USD | Native reportedTurn: input / output / cached input / cache creation / reasoning | Context used / maximum |',
    '| --- | --- | --- | --- | --- | --- |');
  for (const snapshot of summary.productUsage.snapshots) {
    const usage = snapshot.value;
    const totals = usage ? [usage.productTokenTotals.uncachedInputTokens, usage.productTokenTotals.cachedInputTokens, usage.productTokenTotals.cacheCreationTokens, usage.productTokenTotals.outputTokens, usage.productTokenTotals.reasoningTokens].map(cell).join(' / ') : 'unknown';
    const reported = usage ? [usage.reportedTurn.inputTokens, usage.reportedTurn.outputTokens, usage.reportedTurn.cachedInputTokens, usage.reportedTurn.cacheCreationTokens, usage.reportedTurn.reasoningTokens].map(cell).join(' / ') : 'unknown';
    lines.push(`| ${cell(snapshot.runId)} / ${cell(snapshot.sessionId)} / ${cell(snapshot.generationId)} | ${cell(snapshot.status)}; selected ${cell(snapshot.selectedEventId)}; sources ${references(snapshot.eventIds)} | ${totals} | ${cell(usage?.productEstimatedCostUsd ?? null)} | ${reported} | ${cell(usage?.contextWindow.usedTokens ?? null)} / ${cell(usage?.contextWindow.maxTokens ?? null)} |`);
  }
  if (!summary.productUsage.snapshots.length) lines.push('| unknown | none observed | unknown | unknown | unknown | unknown |');
  lines.push('', '## CLI collection duration', '',
    `Observed subprocess-duration sum: ${cell(cliTiming.observedSubprocessDurationMs)} ms; observation-command subtotal: ${cell(cliTiming.observedCollectionDurationMs)} ms; isolated process overhead: unknown.`,
    cliTiming.definition, '',
    '| Source event ID / run | Fixed command family | Purpose | Duration ms | Exit code / outcome | Duplicate of | Limitations |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const interval of cliTiming.intervals) lines.push(`| ${cell(interval.eventId)} / ${cell(interval.runId)} | ${interval.command.map(cell).join(' ')} | ${cell(interval.purpose)} | ${cell(interval.durationMs)} | ${cell(interval.exitCode)} / ${cell(interval.outcome)} | ${cell(interval.duplicateOfEventId)} | ${interval.issues.length ? interval.issues.map(cell).join('; ') : 'none recorded'} |`);
  if (!cliTiming.intervals.length) lines.push('| none observed | unknown | unknown | unknown | unknown | unknown | No trusted subprocess-duration evidence. |');
  lines.push('', '## Limits', '', ...summary.limitations.map(limitation => `- ${cell(limitation)}`), '');
  return lines.join('\n');
}
