import type { PeopleAccountLookup, PeopleCandidatePage, PeopleCandidateQuery, ProjectPeople } from '../../domain/src/people.ts';
import type { LocalProjectTransport } from './local-project-client.ts';
export type { PeopleAccountLookup, PeopleCandidatePage, PeopleCandidatePurpose, PeopleCandidateQuery, PeopleIdentity, ProjectParticipation, ProjectPeople } from '../../domain/src/people.ts';

export function createPeopleClient(send: LocalProjectTransport) {
  const base = (workspaceId: string) => `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/people`;
  return {
    candidates(workspaceId: string, input: PeopleCandidateQuery, signal?: AbortSignal) {
      const query = new URLSearchParams({ purpose: input.purpose });
      if (input.projectId !== undefined) query.set('projectId', input.projectId);
      if (input.q !== undefined) query.set('q', input.q);
      if (input.after !== undefined) query.set('after', input.after);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      return send<PeopleCandidatePage>('GET', `${base(workspaceId)}/candidates?${query}`, undefined, undefined, signal);
    },
    project: (workspaceId: string, projectId: string, signal?: AbortSignal) => send<ProjectPeople>('GET', `${base(workspaceId)}/projects/${encodeURIComponent(projectId)}`, undefined, undefined, signal),
    lookupAccount: (workspaceId: string, email: string, signal?: AbortSignal) => send<PeopleAccountLookup>('GET', `${base(workspaceId)}/account?${new URLSearchParams({ email })}`, undefined, undefined, signal),
  };
}
