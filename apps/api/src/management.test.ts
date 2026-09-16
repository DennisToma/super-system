import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Run } from '@super-system/core';
import { createTestProvider } from '../../../tests/e2e/provider.js';
import { buildApp } from './app.js';
import { createFileStore, emptyState } from './store.js';
import { usageReport } from './usage.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(auth = false) {
  const dir = await mkdtemp(join(tmpdir(), 'control-api-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore(dir); const { provider } = createTestProvider();
  provider.execute = vi.fn(async (_input, emit) => { await emit({ type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }); await emit({ type: 'usage', usage: { durationMs: 12 } }); await emit({ type: 'status', status: 'completed' }); });
  const { app, coordinator } = await buildApp({ host: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:5173', secureCookie: false, dataDir: dir, staticDir: '/missing', environment: 'test', ...(auth ? { password: 'long-test-password', sessionSecret: 's'.repeat(64) } : {}) }, provider, store);
  cleanup.push(() => app.close());
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, payload, headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' }, remoteAddress: '127.0.0.1' });
  return { store, request, provider, coordinator };
}
const skill = { name: 'Briefing', content: 'Summarize open work.', description: 'Daily help', enabled: true, agentIds: ['agent-memo'] };
const server = { name: 'notes', transport: 'http', url: 'https://example.test/mcp', enabled: true, agentIds: ['agent-memo'] };

describe('durable management APIs', () => {
  it('keeps all management areas behind the existing login boundary', async () => {
    const { request } = await setup(true);
    for (const path of ['/skills', '/mcp', '/office', '/usage', '/gateway', '/agents/agent-memo/config']) expect((await request('GET', `/api${path}`)).statusCode).toBe(401);
    expect((await request('POST', '/api/tasks', { title: 'No access' })).statusCode).toBe(401);
  });
  it('creates skills, protects concurrent edits, and rejects unknown assignments', async () => {
    const { request } = await setup();
    expect((await request('POST', '/api/skills', { ...skill, agentIds: ['missing'] })).statusCode).toBe(400);
    const created = await request('POST', '/api/skills', skill); expect(created.statusCode).toBe(201); const item = created.json();
    const updated = await request('PATCH', `/api/skills/${item.id}`, { ...skill, content: 'Updated instructions', expectedVersion: item.version }); expect(updated.statusCode).toBe(200);
    expect((await request('PATCH', `/api/skills/${item.id}`, { ...skill, expectedVersion: item.version })).statusCode).toBe(409);
    expect((await request('DELETE', `/api/skills/${item.id}`, { expectedVersion: item.version })).statusCode).toBe(409);
    expect((await request('DELETE', `/api/skills/${item.id}`, { expectedVersion: updated.json().version })).statusCode).toBe(200);
    expect((await request('GET', '/api/skills')).json()).toEqual([]);
  });
  it('never exposes MCP credentials and preserves them through ordinary edits', async () => {
    const { request, store } = await setup(); const secret = 'private-test-bearer';
    const created = await request('POST', '/api/mcp', { ...server, headers: { Authorization: secret } }); expect(created.statusCode).toBe(201); expect(created.body).not.toContain(secret); const item = created.json();
    const updated = await request('PATCH', `/api/mcp/${item.id}`, { ...server, expectedVersion: item.version }); expect(updated.statusCode).toBe(200); expect(updated.json().hasCredentials).toBe(true);
    expect((await store.read()).mcpServers[0]?.headers).toEqual({ Authorization: secret });
    for (const path of ['/mcp', '/gateway', '/office', '/activity']) expect((await request('GET', `/api${path}`)).body).not.toContain(secret);
    expect((await request('POST', '/api/mcp', server)).statusCode).toBe(409);
    const cleared = await request('PATCH', `/api/mcp/${item.id}`, { ...server, clearCredentials: true, expectedVersion: updated.json().version }); expect(cleared.json().hasCredentials).toBe(false);
    expect((await store.read()).mcpServers[0]?.headers).toBeUndefined();
  });
  it('clears incompatible credentials when a transport changes', async () => {
    const { request, store } = await setup(); const item = (await request('POST', '/api/mcp', { ...server, headers: { Authorization: 'secret' } })).json();
    const changed = await request('PATCH', `/api/mcp/${item.id}`, { name: 'notes', transport: 'stdio', command: 'node', expectedVersion: item.version });
    expect(changed.statusCode).toBe(200); expect(changed.json().hasCredentials).toBe(false); expect((await store.read()).mcpServers[0]?.headers).toBeUndefined();
  });
  it('edits planning tasks without starting an agent and protects stale moves', async () => {
    const { request, provider } = await setup(); const task = (await request('POST', '/api/tasks', { title: 'Review the brief', agentId: 'agent-memo' })).json();
    const moved = await request('PATCH', `/api/tasks/${task.id}`, { title: task.title, agentId: task.agentId, status: 'in_progress', expectedVersion: task.version }); expect(moved.statusCode).toBe(200);
    expect((await request('PATCH', `/api/tasks/${task.id}`, { title: task.title, status: 'done', expectedVersion: task.version })).statusCode).toBe(409);
    expect((await request('GET', '/api/office')).json().tasks[0].status).toBe('in_progress');
    expect(provider.execute).not.toHaveBeenCalled();
    expect((await request('DELETE', `/api/tasks/${task.id}`, { expectedVersion: moved.json().version })).statusCode).toBe(200);
  });
  it('snapshots matching resources once, persists names only, and records usage', async () => {
    const { request, provider, coordinator } = await setup();
    await request('POST', '/api/skills', skill); await request('POST', '/api/skills', { ...skill, name: 'Unassigned', agentIds: [] });
    await request('POST', '/api/mcp', { ...server, headers: { Authorization: 'secret-run-token' } });
    const body = { requestId: randomUUID(), agentId: 'agent-memo', conversationId: 'conversation-welcome', message: 'Hello' };
    const first = await request('POST', '/api/runs', body); expect(first.statusCode).toBe(202); const id = first.json().id;
    await vi.waitFor(async () => expect((await coordinator.get(id)).status).toBe('completed'));
    expect((await request('POST', '/api/runs', body)).json().id).toBe(id); expect(provider.execute).toHaveBeenCalledTimes(1);
    const resources = vi.mocked(provider.execute).mock.calls[0]![2]!;
    expect(resources.skills.map(item => item.name)).toEqual(['Briefing']); expect(resources.mcpServers[0]?.headers).toEqual({ Authorization: 'secret-run-token' });
    const run = await coordinator.get(id); expect(run).toMatchObject({ skillNames: ['Briefing'], mcpServerNames: ['notes'], usage: { totalTokens: 13, durationMs: 12 } });
    expect(JSON.stringify(run)).not.toContain('secret-run-token');
    const report = (await request('GET', '/api/usage?days=7&agentId=agent-memo')).json(); expect(report.totals).toMatchObject({ runs: 1, totalTokens: 13, costUsd: null, costMeasuredRuns: 0 });
  });
  it('hydrates an old state document and preserves new data after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-migration-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const { skills: _skills, tasks: _tasks, mcpServers: _mcp, ...legacy } = emptyState(); legacy.preferences.timezone = 'Europe/Vienna';
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy)); let store = await createFileStore(dir);
    expect(await store.read()).toMatchObject({ skills: [], tasks: [], mcpServers: [], preferences: { timezone: 'Europe/Vienna' } });
    await store.update(state => state.skills.push({ ...skill, id: 's1', version: 'v1', updatedAt: new Date().toISOString() })); await store.close();
    store = await createFileStore(dir); try { expect((await store.read()).skills[0]?.name).toBe('Briefing'); } finally { await store.close(); }
  });
});

describe('usage coverage', () => {
  it('uses UTC boundaries, agent filters, and keeps absent measurements unknown', () => {
    const run = (id: string, agentId: string, createdAt: string, usage?: Run['usage']): Run => ({ id, requestId: id, agentId, createdAt, updatedAt: createdAt, conversationId: 'c', prompt: 'p', response: '', status: 'completed', usage });
    const report = usageReport([run('a', 'one', '2026-09-16T00:00:00.000Z', { totalTokens: 0, costUsd: 0 }), run('b', 'one', '2026-09-15T23:59:59.000Z'), run('c', 'two', '2026-09-16T00:00:00.000Z', { totalTokens: 999 }), run('old', 'one', '2026-09-01T00:00:00.000Z')], [], 7, 'one', new Date('2026-09-16T12:00:00Z'));
    expect(report.totals).toMatchObject({ runs: 2, totalTokens: 0, tokenMeasuredRuns: 1, costUsd: 0, durationMs: null });
    expect(report.daily.at(-2)).toMatchObject({ date: '2026-09-15', runs: 1, totalTokens: null });
    expect(report.daily.at(-1)).toMatchObject({ date: '2026-09-16', runs: 1, totalTokens: 0 });
  });
});
