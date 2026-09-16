import { measurement, type Agent, type Run, type UsageReport, type UsageTotals } from '@super-system/core';

function totals(runs: Run[]): UsageTotals {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd' | 'durationMs') => {
    const values = runs.flatMap(run => { const value = measurement(run.usage?.[key]); return value !== undefined ? [value] : []; });
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return { runs: runs.length, completed: runs.filter(run => run.status === 'completed').length, failed: runs.filter(run => run.status === 'failed').length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'), costUsd: sum('costUsd'), durationMs: sum('durationMs'),
    tokenMeasuredRuns: runs.filter(run => run.usage?.totalTokens !== undefined).length,
    costMeasuredRuns: runs.filter(run => run.usage?.costUsd !== undefined).length,
    durationMeasuredRuns: runs.filter(run => run.usage?.durationMs !== undefined).length };
}
export function usageReport(runs: Run[], agents: Agent[], days: number, agentId?: string, now = new Date()): UsageReport {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const selected = runs.filter(run => (!agentId || run.agentId === agentId) && new Date(run.createdAt) >= start && new Date(run.createdAt) <= now);
  const daily = Array.from({ length: days }, (_, offset) => {
    const date = new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    return { date, ...totals(selected.filter(run => run.createdAt.slice(0, 10) === date)) };
  });
  const ids = [...new Set(selected.map(run => run.agentId))];
  return { days, timezone: 'UTC', agentId, from: start.toISOString(), to: now.toISOString(), totals: totals(selected), daily,
    agents: ids.map(id => ({ agentId: id, name: agents.find(agent => agent.id === id)?.name || id, ...totals(selected.filter(run => run.agentId === id)) })),
    coverage: 'Runs observed by Super System, grouped by their start date in UTC. Token and cost totals include only measurements reported by the provider. Work performed in other clients and unreported billing are not included.' };
}
