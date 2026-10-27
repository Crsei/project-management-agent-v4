import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import { aggregatePortfolioCurrencies, assertPortfolioMoney, isPortfolioCurrency, portfolioForecast, scopePortfolioDashboard, sumPortfolioMoney } from '../../domain/src/dashboard-portfolio.ts';
import type { PortfolioBudgetView, PortfolioDashboard } from '../../domain/src/dashboard-portfolio.ts';
import { dashboardPortfolioCommands } from '../src/dashboard-portfolio.ts';

const budgetRecord = (currency: string, budgetMinor: number, actualMinor: number, remainingEstimateMinor: number): PortfolioBudgetView => ({
  id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', projectId: 'PRJ-1', kind: 'portfolio_budget', ownerId: null,
  version: 1, data: { currency, budgetMinor, remainingEstimateMinor, asOfDate: '2024-02-29' }, actualMinor, forecastMinor: portfolioForecast(actualMinor, remainingEstimateMinor),
  createdAt: '2024-02-29T00:00:00.000Z', updatedAt: '2024-02-29T00:00:00.000Z', createdBy: '33333333-3333-4333-8333-333333333333',
});

test('portfolio money rejects rounding, negatives, unsafe integers and forecast overflow', () => {
  for (const amount of [-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertPortfolioMoney(amount), (error: unknown) => error instanceof DomainError && error.code === 'invalid_money');
  }
  assertPortfolioMoney(0);
  assertPortfolioMoney(Number.MAX_SAFE_INTEGER);
  assert.equal(sumPortfolioMoney([7, 11, 0]), 18);
  assert.equal(portfolioForecast(123, 456), 579);
  assert.throws(() => portfolioForecast(Number.MAX_SAFE_INTEGER, 1), (error: unknown) => error instanceof DomainError && error.code === 'money_overflow');
});

test('portfolio aggregates each explicit currency independently and exposes overflow without rounding', () => {
  const totals = aggregatePortfolioCurrencies([budgetRecord('USD', 10000, 1500, 4000), budgetRecord('JPY', 10000, 2000, 3000), budgetRecord('USD', 5000, 500, 2000)]);
  assert.deepEqual(totals, [
    { currency: 'JPY', projectCount: 1, budgetMinor: 10000, actualMinor: 2000, remainingEstimateMinor: 3000, forecastMinor: 5000, overflow: false },
    { currency: 'USD', projectCount: 2, budgetMinor: 15000, actualMinor: 2000, remainingEstimateMinor: 6000, forecastMinor: 8000, overflow: false },
  ]);
  const overflow = aggregatePortfolioCurrencies([budgetRecord('USD', Number.MAX_SAFE_INTEGER, 0, 0), budgetRecord('USD', 1, 0, 0)]);
  assert.equal(overflow[0]?.budgetMinor, null);
  assert.equal(overflow[0]?.overflow, true);
  assert.equal(overflow[0]?.actualMinor, 0);
  assert.deepEqual(aggregatePortfolioCurrencies([]), []);
});

test('portfolio input contracts require actual dates, ISO currency and explicit assessments', () => {
  assert.equal(isPortfolioCurrency('USD'), true);
  for (const value of ['usd', 'US', 'ZZZ', '']) assert.equal(isPortfolioCurrency(value), false);
  const payload = { currency: 'USD', budgetMinor: 1000, remainingEstimateMinor: 500, asOfDate: '2024-02-29', reason: 'Approved budget' };
  const schema = dashboardPortfolioCommands.SetProjectBudget!.payload;
  assert.equal(schema.safeParse(payload).success, true);
  for (const asOfDate of ['0000-01-01', '2025-02-29', '2024-02-30', '2024-04-31', '2024-2-01', '2024-02-29T00:00:00Z']) assert.equal(schema.safeParse({ ...payload, asOfDate }).success, false);
  for (const budgetMinor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(schema.safeParse({ ...payload, budgetMinor }).success, false);
  const health = dashboardPortfolioCommands.SetProjectHealth!.payload;
  assert.equal(health.safeParse({ status: 'at_risk', rationale: 'Vendor blocked', risks: [{ description: 'Supply delay', severity: 'high', mitigation: 'Alternative supplier' }] }).success, true);
  assert.equal(health.safeParse({ status: 'on_track', rationale: '', risks: [] }).success, false);
  assert.equal(health.safeParse({ status: 'green', rationale: 'Guessed from tasks', risks: [] }).success, false);
  assert.equal(health.safeParse({ status: 'on_track', rationale: 'Reviewed', risks: [], assessedBy: 'spoofed' }).success, false);
  for (const confidence of ['high', 'medium', 'low', null]) {
    const assessed = health.safeParse({ status: 'on_track', confidence, rationale: 'Manual delivery judgment', risks: [] });
    assert.equal(assessed.success, true);
    if (assessed.success) assert.deepEqual(assessed.data, { status: 'on_track', confidence, rationale: 'Manual delivery judgment', risks: [] });
  }
  for (const confidence of ['unknown', 'on_track', '', 0, 75, false, [], {}]) {
    assert.equal(health.safeParse({ status: 'off_track', confidence, rationale: 'No inferred confidence', risks: [] }).success, false);
  }
});

test('portfolio presentation scope filters projects, health counts and same-currency budget totals', () => {
  const dashboard: PortfolioDashboard = {
    projects: [budgetRecord('USD', 1000, 100, 200), budgetRecord('USD', 9000, 300, 400), budgetRecord('JPY', 8000, 500, 600)].map((budget, index) => ({
      projectId: `PRJ-${index + 1}`, health: null, healthHistory: [], budget: { ...budget, projectId: `PRJ-${index + 1}` }, spend: [], financialHistory: [],
    })),
    totals: [],
  };
  const scoped = scopePortfolioDashboard(dashboard, ['PRJ-1', 'PRJ-3']);
  assert.deepEqual(scoped.projects.map(row => row.projectId), ['PRJ-1', 'PRJ-3']);
  assert.equal(scoped.totals.find(row => row.currency === 'USD')?.budgetMinor, 1000);
  assert.equal(scoped.totals.find(row => row.currency === 'USD')?.projectCount, 1);
  assert.equal(scoped.totals.find(row => row.currency === 'JPY')?.budgetMinor, 8000);
  assert.deepEqual(scopePortfolioDashboard(dashboard, []).projects, []);
  assert.deepEqual(scopePortfolioDashboard(dashboard, []).totals, []);
  assert.deepEqual(scopePortfolioDashboard(dashboard, ['PRJ-1'], 'PRJ-2'), { projects: [], totals: [] });
  assert.deepEqual(scopePortfolioDashboard(dashboard, ['PRJ-1', 'PRJ-3'], 'PRJ-3').projects.map(row => row.projectId), ['PRJ-3']);
  assert.equal(dashboard.projects.length, 3);
});
