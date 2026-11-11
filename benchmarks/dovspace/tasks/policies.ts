export const D01_PLAN = [
  { key: 'retention', title: 'Implement current retention', fact: 'retentionDays', value: 30, acceptance: { fact: 'retentionDays', equals: 30, verification: 'retention-boundary' }, dependencies: [] as string[] },
  { key: 'retry', title: 'Implement bounded retries', fact: 'retryLimit', value: 4, acceptance: { fact: 'retryLimit', equals: 4, verification: 'retry-cap' }, dependencies: ['retention'] },
  { key: 'release', title: 'Coordinate release readiness', fact: 'releaseDate', value: '2026-12-15', acceptance: { fact: 'releaseDate', equals: '2026-12-15', verification: 'release-readiness' }, dependencies: ['retention', 'retry'] },
] as const;
