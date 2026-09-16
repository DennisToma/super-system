import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { APP_VERSION, ProviderError, approvalSchema, createConversationSchema, memoryUpdateSchema, preferencesSchema, routineSchema, sendMessageSchema, type AgentProvider, type CapabilityKey, type Connection, type MemoryItem, type RunEvent } from '@super-system/core';
import { registerAuth } from './auth.js';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
import { RunCoordinator } from './runs.js';
import { registerManagement } from './management.js';

const listQuery = z.object({ cursor: z.string().max(1000).optional(), query: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const agentQuery = listQuery.extend({ agentId: z.string().min(1).max(300) });
const idParams = z.object({ id: z.string().min(1).max(300) });
const memoryParams = idParams.extend({ memoryId: z.string().min(1).max(300) });
const routineParams = idParams.extend({ routineId: z.string().min(1).max(300) });
export async function buildApp(config: AppConfig, provider: AgentProvider, store: Store) {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000, trustProxy: false, requestTimeout: 30_000 });
  const coordinator = new RunCoordinator(store, provider);
  await coordinator.recover();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: error.issues.map(issue => issue.message).join(' ') } });
    if (error instanceof ProviderError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const code = (error as { statusCode?: number }).statusCode;
    return reply.code(code && code >= 400 && code < 500 ? code : 500).send({ error: { code: code === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED', message: code === 429 ? 'Too many attempts. Please wait a minute.' : 'The request could not be completed. Check the application server.' } });
  });
  await registerAuth(app, config);
  let connection: Connection | undefined;
  let connectionAt = 0;
  let checking: Promise<Connection> | undefined;
  async function getConnection(force = false): Promise<Connection> {
    if (!force && connection && Date.now() - connectionAt < 10_000) return connection;
    if (checking) return checking;
    checking = provider.checkConnection().then(value => { connection = value; connectionAt = Date.now(); return value; }).finally(() => { checking = undefined; });
    return checking;
  }
  async function requireCapability(key: CapabilityKey) {
    const state = (await getConnection()).capabilities[key];
    if (state.state !== 'supported') throw new ProviderError(state.state === 'unsupported' ? 'UNSUPPORTED' : 'UNAVAILABLE', state.reason || 'This operation is not available for the current connection.', state.state === 'unsupported' ? 501 : 503);
  }
  const sseConnections = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of sseConnections) close(); });
  app.addHook('onClose', async () => { await coordinator.close(); await store.close(); });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/connection', async () => getConnection());
  app.post('/api/connection/check', async () => getConnection(true));
  app.get('/api/agents', async () => provider.listAgents());
  app.get('/api/overview', async request => {
    const { agentId } = z.object({ agentId: z.string().max(300).optional() }).parse(request.query);
    const conn = await getConnection();
    const state = await store.read();
    const agents = conn.status === 'connected' ? await provider.listAgents() : [];
    const selected = agentId || state.preferences.selectedAgentId || agents[0]?.id;
    const counts = { conversations: null as number | null, memory: null as number | null, routines: null as number | null, files: null as number | null };
    if (selected && conn.status === 'connected') {
      const results = await Promise.allSettled([
        provider.listConversations(selected, { limit: 100 }),
        conn.capabilities.memoryRead.state === 'supported' ? provider.listMemory(selected, { limit: 100 }) : Promise.reject(),
        conn.capabilities.routinesRead.state === 'supported' ? provider.listRoutines(selected) : Promise.reject(),
        conn.capabilities.files.state === 'supported' ? provider.listFiles(selected, { limit: 100 }) : Promise.reject(),
      ]);
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const value = result.value;
        const count = Array.isArray(value) ? value.length : value.nextCursor ? null : value.items.length;
        counts[(['conversations', 'memory', 'routines', 'files'] as const)[index]] = count;
      });
    }
    return { connection: conn, agents, counts, recentRuns: state.runs.filter(run => !selected || run.agentId === selected).slice(0, 12), activity: state.activity.filter(item => !selected || !item.agentId || item.agentId === selected).slice(0, 20) };
  });
  app.get('/api/conversations', async request => { const { agentId, ...options } = agentQuery.parse(request.query); return provider.listConversations(agentId, options); });
  app.post('/api/conversations', async (request, reply) => { await requireCapability('conversations'); const body = createConversationSchema.parse(request.body); return reply.code(201).send(await provider.createConversation(body.agentId, body.title)); });
  app.get('/api/conversations/:id/messages', async request => { const { id } = idParams.parse(request.params); const { agentId, ...options } = agentQuery.parse(request.query); return provider.listMessages(id, agentId, options); });
  app.post('/api/runs', async (request, reply) => { const body = sendMessageSchema.parse(request.body); if (!(await store.read()).runs.some(run => run.requestId === body.requestId)) await requireCapability('chat'); return reply.code(202).send(await coordinator.start(body)); });
  app.get('/api/runs', async request => { const { conversationId } = z.object({ conversationId: z.string().max(300).optional() }).parse(request.query); return (await store.read()).runs.filter(run => !conversationId || run.conversationId === conversationId); });
  app.get('/api/runs/:id', async request => coordinator.get(idParams.parse(request.params).id));
  app.post('/api/runs/:id/cancel', async request => { await requireCapability('cancel'); return coordinator.cancel(idParams.parse(request.params).id); });
  app.post('/api/runs/:id/approval', async request => { await requireCapability('approvals'); const body = approvalSchema.parse(request.body); return coordinator.approve(idParams.parse(request.params).id, body.approvalId, body.approved); });
  app.post('/api/runs/:id/reconcile', async request => coordinator.reconcile(idParams.parse(request.params).id));
  app.post('/api/runs/:id/release', async request => { z.object({ acknowledged: z.literal(true) }).parse(request.body); return coordinator.release(idParams.parse(request.params).id); });
  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await coordinator.get(id);
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const lastHeader = request.headers['last-event-id'];
    const header = typeof lastHeader === 'string' ? Number(lastHeader) : 0;
    if (!Number.isSafeInteger(header) || header < 0) throw new ProviderError('VALIDATION', 'Invalid event sequence.', 400);
    let cursor = Math.max(after, header);
    const buffer: RunEvent[] = [];
    let replaying = true;
    let closed = false;
    const write = (event: RunEvent) => {
      if (closed || event.sequence <= cursor) return;
      cursor = event.sequence;
      if (reply.raw.writableLength > 1_000_000) { close(); return; }
      reply.raw.write(`id: ${event.sequence}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = coordinator.subscribe(id, event => replaying ? buffer.push(event) : write(event));
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => { if (closed) return; closed = true; unsubscribe(); if (heartbeat) clearInterval(heartbeat); sseConnections.delete(close); reply.raw.end(); };
    try {
      const replay = await coordinator.events(id, cursor);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      reply.raw.write('retry: 1500\n\n');
      sseConnections.add(close);
      reply.raw.on('close', close);
      for (const event of replay) write(event);
      for (const event of buffer.sort((a, b) => a.sequence - b.sequence)) write(event);
      replaying = false;
      heartbeat = setInterval(() => { if (!closed) reply.raw.write(': keepalive\n\n'); }, 15_000);
      heartbeat.unref();
    } catch (error) { unsubscribe(); throw error; }
  });
  app.get('/api/activity', async () => (await store.read()).activity.slice(0, 200));
  app.get('/api/agents/:id/memory', async request => { await requireCapability('memoryRead'); return provider.listMemory(idParams.parse(request.params).id, listQuery.parse(request.query)); });
  const memoryLocks = new Set<string>();
  async function findMemory(agentId: string, memoryId: string): Promise<MemoryItem> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await provider.listMemory(agentId, { cursor, limit: 100 });
      const item = page.items.find(item => item.id === memoryId);
      if (item) return item;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new ProviderError('PAGINATION_ERROR', 'Letta returned a repeated memory cursor.', 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new ProviderError('NOT_FOUND', 'Memory entry not found.', 404);
  }
  app.patch('/api/agents/:id/memory/:memoryId', async request => {
    await requireCapability('memoryWrite');
    const { id, memoryId } = memoryParams.parse(request.params);
    const body = memoryUpdateSchema.parse(request.body);
    const key = `${id}:${memoryId}`;
    if (memoryLocks.has(key)) throw new ProviderError('MEMORY_CONFLICT', 'Another save is in progress. Reload the entry before saving again.', 409);
    memoryLocks.add(key);
    try {
      const before = await findMemory(id, memoryId);
      if (!before.editable) throw new ProviderError('READ_ONLY', 'This memory entry is read-only.', 403);
      if (before.version !== body.expectedVersion) throw new ProviderError('MEMORY_CONFLICT', 'Memory changed since you loaded it. Reload and compare before saving.', 409);
      if (before.content === body.content) return before;
      const result = await provider.updateMemory(id, memoryId, body.content);
      await store.update(state => {
        const createdAt = new Date().toISOString();
        state.revisions.unshift({ id: randomUUID(), agentId: id, memoryId, title: before.title, before: before.content, after: result.content, createdAt });
        state.activity.unshift({ id: randomUUID(), type: 'memory', title: `Updated ${before.title}`, createdAt, agentId: id });
      });
      return result;
    } finally { memoryLocks.delete(key); }
  });
  app.get('/api/agents/:id/memory/:memoryId/history', async request => { const { id, memoryId } = memoryParams.parse(request.params); return (await store.read()).revisions.filter(item => item.agentId === id && item.memoryId === memoryId); });
  app.get('/api/agents/:id/files', async request => { await requireCapability('files'); return provider.listFiles(idParams.parse(request.params).id, listQuery.parse(request.query)); });
  app.get('/api/agents/:id/routines', async request => { await requireCapability('routinesRead'); return provider.listRoutines(idParams.parse(request.params).id); });
  async function routineActivity(agentId: string, title: string) { await store.update(state => { state.activity.unshift({ id: randomUUID(), type: 'routine', title, agentId, createdAt: new Date().toISOString() }); }); }
  app.post('/api/routines', async (request, reply) => { await requireCapability('routinesWrite'); const input = routineSchema.parse(request.body); const result = await provider.createRoutine(input); await routineActivity(input.agentId, `Created routine: ${input.name}`); return reply.code(201).send(result); });
  app.delete('/api/agents/:id/routines/:routineId', async request => { await requireCapability('routinesWrite'); const { id, routineId } = routineParams.parse(request.params); await provider.deleteRoutine(id, routineId); await routineActivity(id, 'Deleted routine'); return { ok: true }; });
  app.post('/api/agents/:id/routines/:routineId/run', async request => { await requireCapability('routineRun'); const { id, routineId } = routineParams.parse(request.params); await provider.runRoutine(id, routineId); await routineActivity(id, 'Requested routine execution'); return { ok: true }; });
  app.post('/api/agents/:id/routines/:routineId/pause', async request => { await requireCapability('routinePause'); const { paused } = z.object({ paused: z.boolean() }).parse(request.body); const { id, routineId } = routineParams.parse(request.params); await provider.pauseRoutine(id, routineId, paused); await routineActivity(id, paused ? 'Paused routine' : 'Resumed routine'); return { ok: true }; });
  registerManagement(app, provider, store, getConnection, requireCapability);
  app.get('/api/machines', async () => { await requireCapability('machines'); return provider.listMachines(); });
  app.get('/api/system', async () => ({ version: APP_VERSION, connection: await getConnection(), persistence: store.kind, authRequired: Boolean(config.password), environment: config.environment, uptime: process.uptime(), historyCoverage: 'Run activity and memory revisions record changes observed by this application. Edits made elsewhere may not appear here.' }));
  app.get('/api/preferences', async () => (await store.read()).preferences);
  app.put('/api/preferences', async request => { const preferences = preferencesSchema.parse(request.body); await store.update(state => { state.preferences = preferences; }); return preferences; });
  if (existsSync(config.staticDir)) {
    await app.register(staticFiles, { root: config.staticDir, index: ['index.html'] });
    app.setNotFoundHandler(async (request, reply) => request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method) ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }) : reply.sendFile('index.html'));
  } else app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));
  return { app, coordinator };
}
