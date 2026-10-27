import { DomainError } from './core.ts';
import type { DashboardRecord } from './dashboard.ts';

export type ProjectHealthStatus = 'on_track' | 'at_risk' | 'off_track';
export type ProjectDeliveryConfidence = 'high' | 'medium' | 'low';
export type PortfolioRisk = { description: string; severity: 'low' | 'medium' | 'high'; mitigation: string };
export type ProjectHealthAssessment = {
  status: ProjectHealthStatus;
  /** Missing legacy values and null are unknown, never inferred from status or task progress. */
  confidence?: ProjectDeliveryConfidence | null;
  rationale: string;
  risks: PortfolioRisk[];
  assessedBy: string;
  assessedAt: string;
};
export type ProjectBudget = {
  currency: string;
  budgetMinor: number;
  remainingEstimateMinor: number;
  asOfDate: string;
};
export type ProjectSpend = {
  currency: string;
  amountMinor: number;
  spentOn: string;
  description: string;
  correctsSpendId: string | null;
};
export type ProjectSpendVoid = { spendId: string; reason: string };
export type ProjectFinancialSnapshot = ProjectBudget & {
  actualMinor: number;
  forecastMinor: number;
  reason: string;
  cause: 'budget' | 'remaining_estimate' | 'spend' | 'void' | 'correction';
  budgetVersion: number;
  spendId: string | null;
};
export type PortfolioBudgetView = DashboardRecord<ProjectBudget> & { actualMinor: number; forecastMinor: number };
export type PortfolioSpendView = DashboardRecord<ProjectSpend> & { void: DashboardRecord<ProjectSpendVoid> | null };
export type PortfolioProject = {
  projectId: string;
  health: DashboardRecord<ProjectHealthAssessment> | null;
  healthHistory: DashboardRecord<ProjectHealthAssessment>[];
  budget: PortfolioBudgetView | null;
  spend: PortfolioSpendView[];
  financialHistory: DashboardRecord<ProjectFinancialSnapshot>[];
};
/** Null totals mean a safe-integer overflow, never a rounded or partial sum. */
export type PortfolioCurrencyTotal = {
  currency: string;
  projectCount: number;
  budgetMinor: number | null;
  actualMinor: number | null;
  remainingEstimateMinor: number | null;
  forecastMinor: number | null;
  overflow: boolean;
};
export type PortfolioDashboard = { projects: PortfolioProject[]; totals: PortfolioCurrencyTotal[] };
export type ProjectHealthCommandResult = {
  health: DashboardRecord<ProjectHealthAssessment>;
  assessment: DashboardRecord<ProjectHealthAssessment>;
};
export type ProjectBudgetCommandResult = {
  budget: PortfolioBudgetView;
  snapshot: DashboardRecord<ProjectFinancialSnapshot>;
  spend: DashboardRecord<ProjectSpend> | null;
  void: DashboardRecord<ProjectSpendVoid> | null;
};

const currencies = new Set(Intl.supportedValuesOf('currency'));
export function isPortfolioCurrency(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && currencies.has(value);
}
export function assertPortfolioMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError('invalid_money', 'Money must be a non-negative safe integer in minor currency units');
}
export function sumPortfolioMoney(values: Iterable<number>): number {
  let result = 0;
  for (const value of values) {
    assertPortfolioMoney(value);
    result += value;
    if (!Number.isSafeInteger(result)) throw new DomainError('money_overflow', 'The monetary total exceeds the safe integer limit', 409);
  }
  return result;
}
export function portfolioForecast(actualMinor: number, remainingEstimateMinor: number): number {
  return sumPortfolioMoney([actualMinor, remainingEstimateMinor]);
}
export function aggregatePortfolioCurrencies(budgets: readonly PortfolioBudgetView[]): PortfolioCurrencyTotal[] {
  const groups = new Map<string, { count: number; budget: bigint; actual: bigint; remaining: bigint; forecast: bigint }>();
  for (const budget of budgets) {
    const current = groups.get(budget.data.currency) ?? { count: 0, budget: 0n, actual: 0n, remaining: 0n, forecast: 0n };
    for (const value of [budget.data.budgetMinor, budget.actualMinor, budget.data.remainingEstimateMinor, budget.forecastMinor]) assertPortfolioMoney(value);
    current.count += 1;
    current.budget += BigInt(budget.data.budgetMinor);
    current.actual += BigInt(budget.actualMinor);
    current.remaining += BigInt(budget.data.remainingEstimateMinor);
    current.forecast += BigInt(budget.forecastMinor);
    groups.set(budget.data.currency, current);
  }
  const safe = (value: bigint): number | null => value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([currency, group]) => {
    const budgetMinor = safe(group.budget);
    const actualMinor = safe(group.actual);
    const remainingEstimateMinor = safe(group.remaining);
    const forecastMinor = safe(group.forecast);
    return { currency, projectCount: group.count, budgetMinor, actualMinor, remainingEstimateMinor, forecastMinor, overflow: [budgetMinor, actualMinor, remainingEstimateMinor, forecastMinor].includes(null) };
  });
}

/** Presentation filters must scope both project details and same-currency totals. */
export function scopePortfolioDashboard(dashboard: PortfolioDashboard, projectIds: readonly string[], projectId?: string): PortfolioDashboard {
  const visible = new Set(projectIds);
  const projects = dashboard.projects.filter(row => visible.has(row.projectId) && (!projectId || row.projectId === projectId));
  return { projects, totals: aggregatePortfolioCurrencies(projects.flatMap(row => row.budget ? [row.budget] : [])) };
}
