import type { ManagedSkillInfo } from "@pm/openhands-source/web/skills/skill-presentation";
import { agentName } from "@pm/openhands-source/web/skills/skill-presentation";
import { getSkillCardDescription } from "./get-skill-card-description";

export const SKILL_FILTER_QUERY_PARAM = "skills-q";
export type SkillFacetGroupId = "state" | "source" | "agent";
export type SkillEnabledState = "assigned" | "unassigned" | "native";
export interface SkillFilterState {
  query: string;
  sources: Set<string>;
  agents: Set<string>;
  states: Set<SkillEnabledState>;
}
export interface SkillFacetRowModel {
  value: string;
  labelKey: string;
  count: number;
  checked: boolean;
  disabled: boolean;
}
export interface SkillFacetGroup {
  id: SkillFacetGroupId;
  labelKey: string;
  rows: SkillFacetRowModel[];
}
export interface SkillFacetLabels {
  state: string;
  source: string;
  agent: string;
  assigned: string;
  unassigned: string;
  native: string;
  local: string;
}
const DEFAULT_LABELS: SkillFacetLabels = {
  state: "Assignment / discovery", source: "Source", agent: "Agent",
  assigned: "Saved assignment", unassigned: "No saved assignment",
  native: "Native-discovered", local: "Local / ZIP / imported",
};
export const EMPTY_SKILL_FILTER_STATE: SkillFilterState = {
  query: "", sources: new Set(), agents: new Set(), states: new Set(),
};
const GROUP_IDS: readonly SkillFacetGroupId[] = ["state", "source", "agent"];
const STATE_ORDER: readonly SkillEnabledState[] = ["assigned", "unassigned", "native"];
const param = (id: SkillFacetGroupId) => `skills-${id}`;
const selected = (state: SkillFilterState, id: SkillFacetGroupId): Set<string> =>
  id === "state" ? state.states : id === "source" ? state.sources : state.agents;
function withSelected(state: SkillFilterState, id: SkillFacetGroupId, next: Set<string>): SkillFilterState {
  if (id === "state") return { ...state, states: new Set(STATE_ORDER.filter((value) => next.has(value))) };
  return id === "source" ? { ...state, sources: next } : { ...state, agents: next };
}
function valuesOf(skill: ManagedSkillInfo, id: SkillFacetGroupId): string[] {
  if (id === "source") return [skill.source ?? "local"];
  if (id === "agent") return [...skill.assignedAgents, ...skill.nativeDiscoveredAgents];
  return [skill.assignedAgents.length ? "assigned" : "unassigned", ...(skill.nativeDiscoveredAgents.length ? ["native"] : [])];
}
export function parseSkillFilterState(params: URLSearchParams): SkillFilterState {
  return GROUP_IDS.reduce((state, id) => withSelected(state, id, new Set(params.getAll(param(id)).filter(Boolean))), {
    ...EMPTY_SKILL_FILTER_STATE, query: params.get(SKILL_FILTER_QUERY_PARAM) ?? "",
  });
}
export function toSkillFilterSearchParams(state: SkillFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) params.set(SKILL_FILTER_QUERY_PARAM, state.query);
  for (const id of GROUP_IDS) for (const value of [...selected(state, id)].sort()) params.append(param(id), value);
  return params;
}
function matchesQuery(skill: ManagedSkillInfo, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [skill.name, skill.id, skill.source ?? "", getSkillCardDescription(skill),
    ...skill.assignedAgents.map(agentName), ...skill.nativeDiscoveredAgents.map(agentName),
  ].some((value) => value.toLowerCase().includes(normalized));
}
/** OR within a facet, AND across facets; omit own selection for disjunctive counts. */
function matchesFacets(skill: ManagedSkillInfo, state: SkillFilterState, exclude?: SkillFacetGroupId): boolean {
  return GROUP_IDS.every((id) => id === exclude || selected(state, id).size === 0 ||
    valuesOf(skill, id).some((value) => selected(state, id).has(value)));
}
export function applySkillFilters(skills: ManagedSkillInfo[], state: SkillFilterState): ManagedSkillInfo[] {
  return skills.filter((skill) => matchesQuery(skill, state.query) && matchesFacets(skill, state));
}
export function buildSkillFacetGroups(
  skills: ManagedSkillInfo[], state: SkillFilterState, labels: SkillFacetLabels = DEFAULT_LABELS,
): SkillFacetGroup[] {
  const searched = skills.filter((skill) => matchesQuery(skill, state.query));
  return GROUP_IDS.flatMap((id) => {
    const raw = new Set(skills.flatMap((skill) => valuesOf(skill, id)));
    const picked = selected(state, id);
    if (raw.size < 2 && picked.size === 0) return [];
    const values = [...new Set([...raw, ...picked])].sort();
    const candidates = searched.filter((skill) => matchesFacets(skill, state, id));
    const counts = new Map<string, number>();
    for (const skill of candidates) {
      for (const value of valuesOf(skill, id)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [{
      id, labelKey: labels[id],
      rows: values.map((value) => {
        const count = counts.get(value) ?? 0;
        const checked = picked.has(value);
        const label = id === "state" ? labels[value as SkillEnabledState] :
          id === "agent" ? agentName(value) : value === "local" ? labels.local : value;
        return { value, labelKey: label, count, checked, disabled: count === 0 && !checked };
      }),
    }];
  });
}
export function toggleSkillFilterValue(state: SkillFilterState, id: SkillFacetGroupId, value: string): SkillFilterState {
  const next = new Set(selected(state, id));
  if (next.has(value)) next.delete(value); else next.add(value);
  return withSelected(state, id, next);
}
export function clearSkillFilterFacets(state: SkillFilterState): SkillFilterState {
  return { ...EMPTY_SKILL_FILTER_STATE, query: state.query };
}
export function countActiveFilters(state: SkillFilterState): number {
  return GROUP_IDS.reduce((total, id) => total + selected(state, id).size, 0);
}
