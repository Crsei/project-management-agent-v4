import React from 'react';
import type { Diagnostic } from '@pm-schema';

export function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (!diagnostics.length) return null;
  return <ul className="protocol-diagnostics" data-testid="protocol-diagnostics" aria-label="Protocol diagnostics">{diagnostics.map((issue, index) => <li key={`${issue.code}-${issue.path}-${issue.field}-${index}`} className={`diagnostic-${issue.severity}`}><div><strong>{issue.severity.toUpperCase()} · {issue.code}</strong></div><p>{issue.message}</p><div className="mono">{issue.path || 'Workspace'}{issue.line ? `:${issue.line}` : ''}{issue.entityId ? ` · ${issue.entityId}` : ''}{issue.field ? ` · field: ${issue.field}` : ''}{issue.targetId ? ` · target: ${issue.targetId}` : ''}</div></li>)}</ul>;
}
