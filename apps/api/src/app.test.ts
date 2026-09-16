import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilities, ProviderError, type AgentProvider, type EmitEvent, type Run, type StartRunInput } from '@super-system/core';
import { buildApp } from './app.js';
import { readConfig, type AppConfig } from './config.js';
import { createFileStore } from './store.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const config = (dir: string): AppConfig => ({ host: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:5173', secureCookie: false, dataDir: dir, staticDir: '/missing-build', environment: 'test' });
function fixtureProvider(): AgentProvider {
  const memory = { id: 'memory-1', title: 'Persona', content: 'Original', kind: 'core' as const, editable: true, version: '1' };
  return {
    checkConnection: vi.fn(async () => ({ configured: true, status: 'connected' as const, mode: 'legacy' as const, label: 'Test provider', checkedAt: new Date().toISOString(), capabilities: capabilities('supported') })),
    listAgents: vi.fn(async () => [{ id: 'agent-1', name: 'Test agent' }]),
    listConversations: vi.fn(async () => ({ items: [{ id: 'conversation-1', agentId: 'agent-1', title: 'Test conversation' }] })),
    createConversation: vi.fn(async (agentId, title) => ({ id: 'conversation-2', agentId, title: title || 'Conversation' })),
    listMessages: vi.fn(async () => ({ items: [] })),
    execute: vi.fn(async (_input: StartRunInput, emit: EmitEvent) => { await emit({ type: 'text', text: 'A confirmed answer.' }); await emit({ type: 'status', status: 'completed' }); }),
    cancel: vi.fn(async () => {}), approve: vi.fn(async () => {}), reconcile: vi.fn(async () => null),
    listMemory: vi.fn(async () => ({ items: [{ ...memory }] })),
    updateMemory: vi.fn(async (_agentId, _id, content) => { memory.content = content; memory.version = String(Number(memory.version) + 1); return { ...memory }; }),
    listFiles: vi.fn(async () => ({ items: [] })), listRoutines: vi.fn(async () => []),
    createRoutine: vi.fn(async input => ({ ...input, id: 'routine-1', state: 'active' as const })),
    deleteRoutine: vi.fn(async () => {}), runRoutine: vi.fn(async () => {}), pauseRoutine: vi.fn(async () => {}), listMachines: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
}
async function setup(overrides: Partial<AppConfig> = {}, provider = fixtureProvider()) {
  const dir = await mkdtemp(join(tmpdir(), 'super-system-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = await createFileStore(dir);
  const { app, coordinator } = await buildApp({ ...config(dir), ...overrides }, provider, store);
  cleanup.push(() => app.close());
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload: payload as object, headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173', ...headers }, remoteAddress: '127.0.0.1' });
  return { app, coordinator, store, provider, request, dir };
}
const message = () => ({ requestId: randomUUID(), agentId: 'agent-1', conversationId: 'conversation-1', message: 'Hello' });
async function settled(coordinator: Awaited<ReturnType<typeof setup>>['coordinator'], id: string) {
  await vi.waitFor(async () => { expect(['completed', 'failed', 'interrupted', 'waiting_for_approval']).toContain((await coordinator.get(id)).status); });
  return coordinator.get(id);
}

describe('API trust boundary', () => {
  it('rejects hostile origins, DNS-rebinding hosts and unauthenticated proxy exposure', async () => {
    const { request } = await setup();
    expect((await request('GET', '/api/agents', undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await request('GET', '/api/agents', undefined, { host: 'evil.example' })).statusCode).toBe(403);
    expect((await request('GET', '/api/agents', undefined, { 'x-forwarded-for': '192.0.2.1' })).statusCode).toBe(403);
    expect((await request('GET', '/api/agents')).statusCode).toBe(200);
  });
  it('requires a valid HttpOnly session and invalidates a cleared browser cookie', async () => {
    const { request } = await setup({ password: 'a-long-test-password', sessionSecret: 'a'.repeat(64) });
    expect((await request('GET', '/api/agents')).statusCode).toBe(401);
    expect((await request('GET', '/%61pi/preferences')).statusCode).toBe(401);
    expect((await request('PUT', '/%61pi/preferences', { theme: 'dark', timezone: 'UTC' })).statusCode).toBe(401);
    expect((await request('POST', '/api/auth/login', { password: 'wrong' })).statusCode).toBe(401);
    const login = await request('POST', '/api/auth/login', { password: 'a-long-test-password' });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect((await request('GET', '/api/agents', undefined, { cookie })).statusCode).toBe(200);
    expect((await request('GET', '/api/agents', undefined, { cookie: `${cookie}tampered` })).statusCode).toBe(401);
    const logout = await request('POST', '/api/auth/logout', {}, { cookie });
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
  });
  it('validates production configuration without leaking config values', () => {
    expect(() => readConfig({ HOST: '0.0.0.0' })).toThrow('APP_PASSWORD');
    expect(() => readConfig({ NODE_ENV: 'production', APP_PASSWORD: 'sensible-password', SESSION_SECRET: 'a'.repeat(64) })).toThrow('HTTPS');
    expect(() => readConfig({ APP_ORIGIN: 'https://example.com/path' })).toThrow('origin');
    expect(readConfig({ NODE_ENV: 'production', HOST: '0.0.0.0', APP_PASSWORD: 'sensible-password', SESSION_SECRET: 'a'.repeat(64), APP_ORIGIN: 'https://app.example', COOKIE_SECURE: 'true' }).secureCookie).toBe(true);
  });
  it('does not expose raw unexpected upstream errors', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.listAgents).mockRejectedValue(new Error('secret-api-token private.internal')); 
    const { request } = await setup({}, provider);
    const result = await request('GET', '/api/agents');
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret-api-token');
  });
});

describe('durable runs', () => {
  it('deduplicates concurrent sends and rejects request-id reuse with a different prompt', async () => {
    const { request, provider, coordinator } = await setup();
    const body = message();
    const [first, second] = await Promise.all([request('POST', '/api/runs', body), request('POST', '/api/runs', body)]);
    expect(first.statusCode).toBe(202); expect(second.json().id).toBe(first.json().id);
    expect((await settled(coordinator, first.json().id)).response).toBe('A confirmed answer.');
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await request('POST', '/api/runs', { ...body, message: 'Different' })).statusCode).toBe(409);
  });
  it('preserves uncertain outcomes and never automatically resends them', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async (_input, emit) => { await emit({ type: 'text', text: 'Partial' }); throw new Error('socket disconnected'); });
    const { request, coordinator } = await setup({}, provider);
    const body = message();
    const id = (await request('POST', '/api/runs', body)).json().id;
    const run = await settled(coordinator, id);
    expect(run.status).toBe('interrupted'); expect(run.response).toBe('Partial');
    expect((await request('POST', '/api/runs', body)).json().id).toBe(id);
    expect((await request('POST', '/api/runs', message())).statusCode).toBe(409);
    expect((await request('POST', `/api/runs/${id}/reconcile`, {})).statusCode).toBe(409);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps cancellation pending until the provider confirms the outcome', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async () => {});
    vi.mocked(provider.reconcile).mockResolvedValue({ status: 'cancelled' });
    const { request, coordinator } = await setup({}, provider);
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    expect((await request('POST', `/api/runs/${id}/cancel`, {})).json().status).toBe('cancelling');
    expect((await request('POST', `/api/runs/${id}/reconcile`, {})).json().status).toBe('cancelled');
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  });
  it('requires an explicit review before releasing an uncertain conversation for a new send', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async () => { throw new Error('Disconnected'); });
    const { request, coordinator } = await setup({}, provider);
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    expect((await request('POST', `/api/runs/${id}/release`, {})).statusCode).toBe(400);
    const released = await request('POST', `/api/runs/${id}/release`, { acknowledged: true });
    expect(released.json().status).toBe('interrupted');
    expect(released.json().releasedAt).toBeTruthy();
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await request('POST', '/api/runs', message())).statusCode).toBe(202);
    expect(provider.cancel).not.toHaveBeenCalled();
  });
  it('rejects stale approvals and sends a matching approval once', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async (_input, emit) => emit({ type: 'approval', approval: { id: 'approval-1', toolName: 'write_file', arguments: '{}' } }));
    const { request, coordinator } = await setup({}, provider);
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    expect((await request('POST', `/api/runs/${id}/approval`, { approvalId: 'stale', approved: true })).statusCode).toBe(409);
    expect((await request('POST', `/api/runs/${id}/approval`, { approvalId: 'approval-1', approved: false })).statusCode).toBe(200);
    expect((await request('POST', `/api/runs/${id}/approval`, { approvalId: 'approval-1', approved: false })).statusCode).toBe(409);
    expect(provider.approve).toHaveBeenCalledTimes(1);
  });
  it('preserves an approval when cancellation fails', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async (_input, emit) => emit({ type: 'approval', approval: { id: 'approval-1', toolName: 'write_file', arguments: '{}' } }));
    vi.mocked(provider.cancel).mockRejectedValue(new ProviderError('PROVIDER_REJECTED', 'Cancellation rejected.', 502));
    const { request, coordinator } = await setup({}, provider);
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    expect((await request('POST', `/api/runs/${id}/cancel`, {})).statusCode).toBe(502);
    expect((await coordinator.get(id)).approval?.id).toBe('approval-1');
    expect((await coordinator.get(id)).status).toBe('waiting_for_approval');
    expect((await request('POST', `/api/runs/${id}/approval`, { approvalId: 'approval-1', approved: true })).statusCode).toBe(200);
  });
  it('does not overwrite a live approval with an older reconciliation snapshot', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.execute).mockImplementation(async () => {});
    const { request, coordinator } = await setup({}, provider);
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    vi.mocked(provider.reconcile).mockImplementation(async () => {
      await coordinator.emit(id, { type: 'approval', approval: { id: 'new-approval', toolName: 'write_file', arguments: '{}' } });
      return { status: 'running', response: 'Stale' };
    });
    const reconciled = (await request('POST', `/api/runs/${id}/reconcile`, {})).json();
    expect(reconciled.status).toBe('waiting_for_approval');
    expect(reconciled.approval.id).toBe('new-approval');
    expect(reconciled.response).not.toBe('Stale');
  });
  it('replays events after a sequence and protects completed results against late events', async () => {
    const { request, coordinator } = await setup();
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    const events = await coordinator.events(id, 0);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect((await coordinator.events(id, 2)).map(event => event.sequence)).toEqual([3, 4]);
    await coordinator.emit(id, { type: 'status', status: 'running' });
    expect((await coordinator.get(id)).status).toBe('completed');
  });
  it('marks unresolved records interrupted after restart while retaining the original request', async () => {
    const { coordinator, store, provider } = await setup();
    const now = new Date().toISOString();
    const record: Run = { id: 'persisted-run', requestId: randomUUID(), agentId: 'agent-1', conversationId: 'conversation-1', prompt: 'Already sent', response: 'Partial output', status: 'running', createdAt: now, updatedAt: now };
    await store.update(state => { state.runs.push(record); });
    await coordinator.recover();
    expect((await coordinator.get(record.id)).status).toBe('interrupted');
    expect((await coordinator.get(record.id)).response).toBe('Partial output');
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it('streams replay and new events even after a previous client disconnects', async () => {
    const { app, coordinator, request } = await setup();
    const id = (await request('POST', '/api/runs', message())).json().id;
    await settled(coordinator, id);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpGet(`${url}/api/runs/${id}/events?after=2`, { headers: { host: '127.0.0.1:3001' } }, res => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); if (body.includes('id: 4')) { req.destroy(); resolve(body); } });
      });
      req.on('error', reject);
    });
    expect(text).toContain('id: 3'); expect(text).toContain('id: 4'); expect(text).not.toContain('id: 2');
    expect((await coordinator.get(id)).status).toBe('completed');
  });
});

describe('memory and supported actions', () => {
  it('detects changed memory and records only successful edits', async () => {
    const { request, provider } = await setup();
    const path = '/api/agents/agent-1/memory/memory-1';
    expect((await request('PATCH', path, { content: 'New', expectedVersion: 'outdated' })).statusCode).toBe(409);
    expect(provider.updateMemory).not.toHaveBeenCalled();
    const saved = await request('PATCH', path, { content: 'New', expectedVersion: '1' });
    expect(saved.json().content).toBe('New');
    const history = (await request('GET', `${path}/history`)).json();
    expect(history).toHaveLength(1); expect(history[0].before).toBe('Original'); expect(history[0].after).toBe('New');
    expect((await request('PATCH', path, { content: 'Old tab', expectedVersion: '1' })).statusCode).toBe(409);
  });
  it('returns unsupported explicitly and does not execute the action', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.checkConnection).mockImplementation(async () => ({ configured: true, status: 'connected', mode: 'legacy', label: 'Test', checkedAt: new Date().toISOString(), capabilities: capabilities('unsupported', 'Unavailable in this version.') }));
    const { request } = await setup({}, provider);
    expect((await request('POST', '/agents/agent-1/routines/routine-1/run', {})).statusCode).toBe(404);
    expect((await request('POST', '/api/agents/agent-1/routines/routine-1/run', {})).statusCode).toBe(501);
    expect(provider.runRoutine).not.toHaveBeenCalled();
  });
  it('rejects invalid timezone and preserves upstream failure without a false audit success', async () => {
    const provider = fixtureProvider();
    vi.mocked(provider.createRoutine).mockRejectedValue(new ProviderError('PROVIDER_REJECTED', 'Schedule rejected.', 400));
    const { request } = await setup({}, provider);
    const input = { agentId: 'agent-1', name: 'Check', prompt: 'Status', cron: '0 8 * * *', timezone: 'Mars/Olympus' };
    expect((await request('POST', '/api/routines', input)).statusCode).toBe(400);
    expect(provider.createRoutine).not.toHaveBeenCalled();
    expect((await request('POST', '/api/routines', { ...input, timezone: 'Europe/Vienna' })).statusCode).toBe(400);
    expect((await request('GET', '/api/activity')).json()).toEqual([]);
  });
});

describe('file persistence', () => {
  it('serializes concurrent updates, rejects another owner, and reopens committed state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'super-system-store-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = await createFileStore(dir);
    await expect(createFileStore(dir)).rejects.toThrow('already in use');
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(state => { state.activity.push({ id: String(i), type: 'system', title: 'Persisted', createdAt: new Date().toISOString() }); })));
    await expect(store.update(state => { state.activity = []; throw new Error('Rejected mutation'); })).rejects.toThrow('Rejected mutation');
    expect((await store.read()).activity).toHaveLength(20);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).activity).toHaveLength(20);
    await store.close();
    const reopened = await createFileStore(dir);
    expect((await reopened.read()).activity).toHaveLength(20);
    await reopened.close();
  });
});
