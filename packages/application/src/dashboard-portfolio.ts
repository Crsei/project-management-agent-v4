import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Entity } from '../../domain/src/core.ts';
import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import { aggregatePortfolioCurrencies, isPortfolioCurrency, portfolioForecast, sumPortfolioMoney } from '../../domain/src/dashboard-portfolio.ts';
import type { PortfolioBudgetView, PortfolioDashboard, ProjectBudget, ProjectBudgetCommandResult, ProjectFinancialSnapshot, ProjectHealthAssessment, ProjectHealthCommandResult, ProjectSpend, ProjectSpendVoid } from '../../domain/src/dashboard-portfolio.ts';
import { assertProjectWritable, assertRule } from '../../domain/src/planning.ts';
import { requireCapability } from './access.ts';
import type { DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, listDashboardRecords, readDashboardRecord, updateDashboardRecord } from './dashboard-store.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';

const reason = z.string().trim().min(1).max(16000);
const currency = z.string().refine(isPortfolioCurrency, 'Expected a supported uppercase ISO 4217 currency');
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.iso.date().refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return value >= '0001-01-01' && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, 'Expected an actual calendar date');
const spendFields = { currency, amountMinor: minor.refine(value => value > 0, 'Spend must be positive'), spentOn: date, description: reason };
const spendId = z.uuid().toLowerCase();
const healthPayload = z.strictObject({
  status: z.enum(['on_track', 'at_risk', 'off_track']),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  rationale: reason,
  risks: z.array(z.strictObject({ description: reason, severity: z.enum(['low', 'medium', 'high']), mitigation: z.string().trim().max(16000) })).max(100),
});

async function projectForWrite(ctx: CommandContext): Promise<Entity> {
  assertRule(ctx.command.targetId, 'target_required');
  assertRule(!ctx.command.projectId || ctx.command.projectId === ctx.command.targetId, 'project_mismatch');
  await ctx.require('planning.edit', ctx.command.targetId);
  const project = await ctx.get(ctx.command.targetId, 'project');
  assertRule(project.data.archived !== true, 'object_archived');
  assertProjectWritable(project);
  ctx.checkVersion(project);
  return project;
}

/** Limit command receipt scopes to the project actually being changed. */
async function projectRecords<T>(ctx: CommandContext, kind: string, projectId: string): Promise<DashboardRecord<T>[]> {
  const result = await ctx.sql.query<{ id: string }>('SELECT id FROM dashboard_records WHERE workspace_id=$1 AND project_id=$2 AND kind=$3 ORDER BY created_at,id', [ctx.workspaceId, projectId, kind]);
  const records: DashboardRecord<T>[] = [];
  for (const row of result.rows) records.push(await readDashboardRecord<T>(ctx, row.id, kind));
  return records;
}

async function budgetState(ctx: CommandContext, project: Entity): Promise<{ budget: DashboardRecord<ProjectBudget> | null; spend: DashboardRecord<ProjectSpend>[]; voids: DashboardRecord<ProjectSpendVoid>[] }> {
  const budgets = await projectRecords<ProjectBudget>(ctx, 'portfolio_budget', project.id);
  const spend = await projectRecords<ProjectSpend>(ctx, 'portfolio_spend', project.id);
  const voids = await projectRecords<ProjectSpendVoid>(ctx, 'portfolio_spend_void', project.id);
  return { budget: budgets[0] ?? null, spend, voids };
}

function actualSpend(spend: readonly DashboardRecord<ProjectSpend>[], voids: readonly DashboardRecord<ProjectSpendVoid>[], projectCurrency: string): number {
  const voided = new Set(voids.map(row => row.data.spendId));
  for (const entry of spend) assertRule(entry.data.currency === projectCurrency, 'currency_mismatch');
  return sumPortfolioMoney(spend.filter(row => !voided.has(row.id)).map(row => row.data.amountMinor));
}

function assertAsOf(asOfDate: string, spend: readonly DashboardRecord<ProjectSpend>[], voids: readonly DashboardRecord<ProjectSpendVoid>[]): void {
  assertRule(asOfDate <= new Date().toISOString().slice(0, 10), 'future_financial_date');
  const voided = new Set(voids.map(row => row.data.spendId));
  assertRule(spend.every(row => voided.has(row.id) || row.data.spentOn <= asOfDate), 'financial_date_precedes_spend');
}

async function saveBudget(ctx: CommandContext, project: Entity, previous: DashboardRecord<ProjectBudget> | null, data: ProjectBudget, actualMinor: number, cause: ProjectFinancialSnapshot['cause'], explanation: string, spend: DashboardRecord<ProjectSpend> | null = null, voidRecord: DashboardRecord<ProjectSpendVoid> | null = null): Promise<ProjectBudgetCommandResult> {
  const forecastMinor = portfolioForecast(actualMinor, data.remainingEstimateMinor);
  const budget = previous
    ? await updateDashboardRecord(ctx, previous, data)
    : await insertDashboardRecord(ctx, { kind: 'portfolio_budget', projectId: project.id, data });
  const snapshot = await insertDashboardRecord<ProjectFinancialSnapshot>(ctx, {
    kind: 'portfolio_financial_snapshot', projectId: project.id,
    data: { ...data, actualMinor, forecastMinor, budgetVersion: budget.version, cause, reason: explanation, spendId: spend?.id ?? voidRecord?.data.spendId ?? null },
  });
  await emitDashboardEvent(ctx, 'ProjectFinancialsChanged', budget);
  return { budget: { ...budget, actualMinor, forecastMinor }, snapshot, spend, void: voidRecord };
}

export const dashboardPortfolioCommands: CommandRegistry = {
  SetProjectHealth: {
    payload: healthPayload,
    async handler(ctx): Promise<ProjectHealthCommandResult> {
      const project = await projectForWrite(ctx);
      const previous = (await projectRecords<ProjectHealthAssessment>(ctx, 'portfolio_health', project.id))[0];
      const payload = healthPayload.parse(ctx.command.payload);
      // Legacy callers omit confidence: preserve the current manual value, or unknown.
      // Explicit null clears it. The new immutable assessment snapshots that exact value.
      const confidence = payload.confidence === undefined ? previous?.data.confidence ?? null : payload.confidence;
      const data: ProjectHealthAssessment = { ...payload, confidence, assessedBy: ctx.actor.id, assessedAt: new Date().toISOString() };
      const health = previous ? await updateDashboardRecord(ctx, previous, data) : await insertDashboardRecord(ctx, { kind: 'portfolio_health', projectId: project.id, data });
      const assessment = await insertDashboardRecord(ctx, { kind: 'portfolio_health_assessment', projectId: project.id, data });
      await emitDashboardEvent(ctx, 'ProjectHealthAssessed', health);
      return { health, assessment };
    },
  },
  SetProjectBudget: {
    payload: z.strictObject({ currency, budgetMinor: minor, remainingEstimateMinor: minor, asOfDate: date, reason }),
    async handler(ctx): Promise<ProjectBudgetCommandResult> {
      const project = await projectForWrite(ctx);
      const state = await budgetState(ctx, project);
      const payload = ctx.command.payload as ProjectBudget & { reason: string };
      assertRule(!state.budget || state.budget.data.currency === payload.currency || state.spend.length === 0, 'currency_locked_by_ledger', 'A project with a spend ledger cannot change currency, including after voids');
      assertAsOf(payload.asOfDate, state.spend, state.voids);
      const { reason: explanation, ...data } = payload;
      return saveBudget(ctx, project, state.budget, data, actualSpend(state.spend, state.voids, data.currency), 'budget', explanation);
    },
  },
  SetProjectRemainingEstimate: {
    payload: z.strictObject({ remainingEstimateMinor: minor, asOfDate: date, reason }),
    async handler(ctx): Promise<ProjectBudgetCommandResult> {
      const project = await projectForWrite(ctx);
      const state = await budgetState(ctx, project);
      assertRule(state.budget, 'project_budget_required');
      const payload = ctx.command.payload as { remainingEstimateMinor: number; asOfDate: string; reason: string };
      assertAsOf(payload.asOfDate, state.spend, state.voids);
      return saveBudget(ctx, project, state.budget, { ...state.budget.data, remainingEstimateMinor: payload.remainingEstimateMinor, asOfDate: payload.asOfDate }, actualSpend(state.spend, state.voids, state.budget.data.currency), 'remaining_estimate', payload.reason);
    },
  },
  RecordProjectSpend: {
    payload: z.strictObject(spendFields),
    async handler(ctx): Promise<ProjectBudgetCommandResult> {
      const project = await projectForWrite(ctx);
      const state = await budgetState(ctx, project);
      assertRule(state.budget, 'project_budget_required');
      const payload = ctx.command.payload as Omit<ProjectSpend, 'correctsSpendId'>;
      assertRule(payload.currency === state.budget.data.currency, 'currency_mismatch');
      const asOfDate = new Date().toISOString().slice(0, 10);
      assertRule(payload.spentOn <= asOfDate, 'future_financial_date');
      const actualMinor = sumPortfolioMoney([actualSpend(state.spend, state.voids, payload.currency), payload.amountMinor]);
      portfolioForecast(actualMinor, state.budget.data.remainingEstimateMinor);
      const spend = await insertDashboardRecord<ProjectSpend>(ctx, { kind: 'portfolio_spend', projectId: project.id, data: { ...payload, correctsSpendId: null } });
      return saveBudget(ctx, project, state.budget, { ...state.budget.data, asOfDate }, actualMinor, 'spend', payload.description, spend);
    },
  },
  VoidProjectSpend: {
    payload: z.strictObject({ spendId, reason }),
    async handler(ctx): Promise<ProjectBudgetCommandResult> {
      const project = await projectForWrite(ctx);
      const state = await budgetState(ctx, project);
      assertRule(state.budget, 'project_budget_required');
      const payload = ctx.command.payload as ProjectSpendVoid;
      const spend = await readDashboardRecord<ProjectSpend>(ctx, payload.spendId, 'portfolio_spend');
      assertRule(spend.projectId === project.id, 'project_mismatch');
      assertRule(!state.voids.some(row => row.data.spendId === spend.id), 'spend_already_voided');
      const voidRecord = await insertDashboardRecord(ctx, { kind: 'portfolio_spend_void', projectId: project.id, data: payload });
      return saveBudget(ctx, project, state.budget, { ...state.budget.data, asOfDate: new Date().toISOString().slice(0, 10) }, actualSpend(state.spend, [...state.voids, voidRecord], state.budget.data.currency), 'void', payload.reason, null, voidRecord);
    },
  },
  CorrectProjectSpend: {
    payload: z.strictObject({ spendId, reason, ...spendFields }),
    async handler(ctx): Promise<ProjectBudgetCommandResult> {
      const project = await projectForWrite(ctx);
      const state = await budgetState(ctx, project);
      assertRule(state.budget, 'project_budget_required');
      const payload = ctx.command.payload as Omit<ProjectSpend, 'correctsSpendId'> & ProjectSpendVoid;
      const original = await readDashboardRecord<ProjectSpend>(ctx, payload.spendId, 'portfolio_spend');
      assertRule(original.projectId === project.id, 'project_mismatch');
      assertRule(!state.voids.some(row => row.data.spendId === original.id), 'spend_already_voided');
      assertRule(payload.currency === state.budget.data.currency, 'currency_mismatch');
      const asOfDate = new Date().toISOString().slice(0, 10);
      assertRule(payload.spentOn <= asOfDate, 'future_financial_date');
      const voidRecord = await insertDashboardRecord<ProjectSpendVoid>(ctx, { kind: 'portfolio_spend_void', projectId: project.id, data: { spendId: original.id, reason: payload.reason } });
      const actualMinor = sumPortfolioMoney([actualSpend(state.spend, [...state.voids, voidRecord], payload.currency), payload.amountMinor]);
      portfolioForecast(actualMinor, state.budget.data.remainingEstimateMinor);
      const spend = await insertDashboardRecord<ProjectSpend>(ctx, { kind: 'portfolio_spend', projectId: project.id, data: { currency: payload.currency, amountMinor: payload.amountMinor, spentOn: payload.spentOn, description: payload.description, correctsSpendId: original.id } });
      return saveBudget(ctx, project, state.budget, { ...state.budget.data, asOfDate }, actualMinor, 'correction', payload.reason, spend, voidRecord);
    },
  },
};

export async function readPortfolioDashboard(ctx: DashboardReadContext): Promise<PortfolioDashboard> {
  const projects = await ctx.core.list('project');
  const health = await listDashboardRecords<ProjectHealthAssessment>(ctx, 'portfolio_health');
  const healthHistory = await listDashboardRecords<ProjectHealthAssessment>(ctx, 'portfolio_health_assessment');
  const budgets = await listDashboardRecords<ProjectBudget>(ctx, 'portfolio_budget');
  const spend = await listDashboardRecords<ProjectSpend>(ctx, 'portfolio_spend');
  const voids = await listDashboardRecords<ProjectSpendVoid>(ctx, 'portfolio_spend_void');
  const history = await listDashboardRecords<ProjectFinancialSnapshot>(ctx, 'portfolio_financial_snapshot');
  const result: PortfolioDashboard = { projects: [], totals: [] };
  const currentBudgets: PortfolioBudgetView[] = [];
  for (const project of projects) {
    await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', project.id);
    const projectSpend = spend.filter(row => row.projectId === project.id);
    const projectVoids = voids.filter(row => row.projectId === project.id);
    const savedBudget = budgets.find(row => row.projectId === project.id);
    let budget: PortfolioBudgetView | null = null;
    if (savedBudget) {
      const actualMinor = actualSpend(projectSpend, projectVoids, savedBudget.data.currency);
      budget = { ...savedBudget, actualMinor, forecastMinor: portfolioForecast(actualMinor, savedBudget.data.remainingEstimateMinor) };
      currentBudgets.push(budget);
    } else if (projectSpend.length || projectVoids.length) throw new DomainError('portfolio_integrity_error', 'Spend ledger has no project budget', 500);
    result.projects.push({
      projectId: project.id,
      health: health.find(row => row.projectId === project.id) ?? null,
      healthHistory: healthHistory.filter(row => row.projectId === project.id),
      budget,
      spend: projectSpend.map(row => ({ ...row, void: projectVoids.find(entry => entry.data.spendId === row.id) ?? null })),
      financialHistory: history.filter(row => row.projectId === project.id),
    });
  }
  result.totals = aggregatePortfolioCurrencies(currentBudgets);
  return result;
}
