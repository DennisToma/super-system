import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ProviderError, agentConfigPatchSchema, skillInputSchema, skillUpdateSchema, mcpInputSchema, mcpUpdateSchema, taskInputSchema, taskUpdateSchema,
  type AgentProvider, type CapabilityKey, type Connection, type McpInput, type McpServer, type GatewayInfo,
} from '@super-system/core';
import { testMcpConnection } from '@super-system/provider-letta';
import type { Store, State, McpServerRecord } from './store.js';
import { usageReport } from './usage.js';

const ids = z.object({ id: z.string().min(1).max(300) });
const revision = z.object({ expectedVersion: z.string().min(1).max(100) }).strict();
const notFound = () => new ProviderError('NOT_FOUND', 'This item no longer exists.', 404);
function checkVersion(item: { version: string }, expected: string) {
  if (item.version !== expected) throw new ProviderError('EDIT_CONFLICT', 'This item changed since you opened it. Reload and compare before saving.', 409);
}
function publicMcp(server: McpServerRecord): McpServer {
  const { id, name, transport, command, args, url, enabled, agentIds, version, updatedAt } = server;
  return { id, name, transport, command, args, url, enabled, agentIds, version, updatedAt, hasCredentials: Boolean(Object.keys(server.env || {}).length || Object.keys(server.headers || {}).length) };
}
function mcpRecord(input: McpInput, previous?: McpServerRecord): McpServerRecord {
  const changedTransport = previous && previous.transport !== input.transport;
  const preserved = input.clearCredentials || changedTransport ? {} : { env: previous?.env, headers: previous?.headers };
  const env = input.transport === 'stdio' ? input.env ?? preserved.env : undefined;
  const headers = input.transport !== 'stdio' ? input.headers ?? preserved.headers : undefined;
  return { id: previous?.id || randomUUID(), name: input.name, transport: input.transport, command: input.command, args: input.args, url: input.url,
    enabled: input.enabled, agentIds: [...new Set(input.agentIds)], env, headers, version: randomUUID(), updatedAt: new Date().toISOString() };
}
function activity(state: State, title: string, agentId?: string) {
  state.activity.unshift({ id: randomUUID(), type: 'system', title, agentId, createdAt: new Date().toISOString() });
}
export function registerManagement(app: FastifyInstance, provider: AgentProvider, store: Store, getConnection: () => Promise<Connection>, requireCapability: (key: CapabilityKey) => Promise<void>) {
  async function validateAgents(assigned: string[]) {
    if (!assigned.length) return;
    const valid = new Set((await provider.listAgents()).map(agent => agent.id));
    if (assigned.some(id => !valid.has(id))) throw new ProviderError('VALIDATION', 'Choose agents that are available on this connection.', 400);
  }
  app.get('/api/skills', async () => (await store.read()).skills);
  app.post('/api/skills', async (request, reply) => {
    const input = skillInputSchema.parse(request.body); await validateAgents(input.agentIds);
    const item = { ...input, agentIds: [...new Set(input.agentIds)], id: randomUUID(), version: randomUUID(), updatedAt: new Date().toISOString() };
    await store.update(state => { state.skills.unshift(item); activity(state, `Created skill: ${item.name}`); });
    return reply.code(201).send(item);
  });
  app.patch('/api/skills/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion, ...input } = skillUpdateSchema.parse(request.body); await validateAgents(input.agentIds);
    return store.update(state => {
      const index = state.skills.findIndex(item => item.id === id); if (index < 0) throw notFound(); checkVersion(state.skills[index]!, expectedVersion);
      const item = { ...input, agentIds: [...new Set(input.agentIds)], id, version: randomUUID(), updatedAt: new Date().toISOString() };
      state.skills[index] = item; activity(state, `Updated skill: ${item.name}`); return item;
    });
  });
  app.delete('/api/skills/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion } = revision.parse(request.body);
    await store.update(state => { const item = state.skills.find(item => item.id === id); if (!item) throw notFound(); checkVersion(item, expectedVersion); state.skills = state.skills.filter(item => item.id !== id); activity(state, `Deleted skill: ${item.name}`); }); return { ok: true };
  });
  app.get('/api/mcp', async () => (await store.read()).mcpServers.map(publicMcp));
  app.post('/api/mcp', async (request, reply) => {
    const input = mcpInputSchema.parse(request.body); await validateAgents(input.agentIds);
    const item = mcpRecord(input);
    await store.update(state => { if (state.mcpServers.some(server => server.name === item.name)) throw new ProviderError('NAME_CONFLICT', 'A server with this name already exists.', 409); state.mcpServers.unshift(item); activity(state, `Added MCP server: ${item.name}`); });
    return reply.code(201).send(publicMcp(item));
  });
  app.patch('/api/mcp/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion, ...input } = mcpUpdateSchema.parse(request.body); await validateAgents(input.agentIds);
    const result = await store.update(state => {
      const index = state.mcpServers.findIndex(item => item.id === id); if (index < 0) throw notFound(); const before = state.mcpServers[index]!; checkVersion(before, expectedVersion);
      if (state.mcpServers.some(server => server.id !== id && server.name === input.name)) throw new ProviderError('NAME_CONFLICT', 'A server with this name already exists.', 409);
      const item = mcpRecord(input, before); state.mcpServers[index] = item; activity(state, `Updated MCP server: ${item.name}`); return publicMcp(item);
    }); return result;
  });
  app.delete('/api/mcp/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion } = revision.parse(request.body);
    await store.update(state => { const item = state.mcpServers.find(item => item.id === id); if (!item) throw notFound(); checkVersion(item, expectedVersion); state.mcpServers = state.mcpServers.filter(item => item.id !== id); activity(state, `Removed MCP server: ${item.name}`); }); return { ok: true };
  });
  const testing = new Set<string>();
  app.post('/api/mcp/:id/test', async request => {
    const { id } = ids.parse(request.params); const item = (await store.read()).mcpServers.find(item => item.id === id); if (!item) throw notFound();
    if (testing.has(id) || testing.size >= 3) throw new ProviderError('BUSY', 'A connection test is already running. Please wait.', 409);
    testing.add(id);
    try { return await testMcpConnection(item); }
    finally { testing.delete(id); }
  });
  const configLocks = new Set<string>();
  app.get('/api/agents/:id/config', async request => {
    await requireCapability('agentConfigRead'); if (!provider.getAgentConfiguration) throw new ProviderError('UNSUPPORTED', 'Agent configuration is unavailable for this provider.', 501);
    return provider.getAgentConfiguration(ids.parse(request.params).id);
  });
  app.patch('/api/agents/:id/config', async request => {
    await requireCapability('agentConfigWrite'); if (!provider.updateAgentConfiguration) throw new ProviderError('UNSUPPORTED', 'Agent configuration editing is unavailable for this provider.', 501);
    const { id } = ids.parse(request.params); const input = agentConfigPatchSchema.parse(request.body);
    if (configLocks.has(id)) throw new ProviderError('EDIT_CONFLICT', 'Another configuration save is in progress.', 409);
    configLocks.add(id);
    try { const saved = await provider.updateAgentConfiguration(id, input); await store.update(state => activity(state, 'Updated agent configuration', id)); return saved; }
    finally { configLocks.delete(id); }
  });
  app.get('/api/gateway', async (): Promise<GatewayInfo> => {
    const connection = await getConnection(); const state = await store.read();
    let runtime: GatewayInfo['runtime']; let runtimeError: string | undefined;
    if (connection.status === 'connected' && connection.capabilities.gateway.state === 'supported' && provider.getGatewayRuntime) {
      try { runtime = await provider.getGatewayRuntime(); } catch { runtimeError = 'Runtime diagnostics could not be read. Check the connection and retry.'; }
    }
    return { connection, runtime, runtimeError, uptime: process.uptime(),
      activeRuns: state.runs.filter(run => ['queued', 'running', 'cancelling'].includes(run.status)).length,
      waitingRuns: state.runs.filter(run => run.status === 'waiting_for_approval').length,
      interruptedRuns: state.runs.filter(run => run.status === 'interrupted' && !run.releasedAt).length,
      mcpEnabled: state.mcpServers.filter(server => server.enabled).length,
      transport: connection.mode === 'app-server' ? 'WebSocket App Server' : 'HTTP REST API',
      historyCoverage: 'Connection diagnostics and runs observed by this application. Remote process, SSH tunnel, and channel lifecycle are managed on the host.' };
  });
  app.get('/api/office', async () => {
    const connection = await getConnection(); const state = await store.read();
    const agents = connection.status === 'connected' ? await provider.listAgents() : [];
    return { connection, agents, tasks: state.tasks, runs: state.runs.slice(0, 200), activity: state.activity.slice(0, 100) };
  });
  app.post('/api/tasks', async (request, reply) => {
    const input = taskInputSchema.parse(request.body); await validateAgents(input.agentId ? [input.agentId] : []); const now = new Date().toISOString();
    const item = { ...input, id: randomUUID(), version: randomUUID(), createdAt: now, updatedAt: now };
    await store.update(state => { state.tasks.unshift(item); activity(state, `Created task: ${item.title}`, item.agentId); }); return reply.code(201).send(item);
  });
  app.patch('/api/tasks/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion, ...input } = taskUpdateSchema.parse(request.body); await validateAgents(input.agentId ? [input.agentId] : []);
    return store.update(state => {
      const index = state.tasks.findIndex(item => item.id === id); if (index < 0) throw notFound(); const before = state.tasks[index]!; checkVersion(before, expectedVersion);
      const item = { ...input, id, createdAt: before.createdAt, updatedAt: new Date().toISOString(), version: randomUUID() }; state.tasks[index] = item; activity(state, `Updated task: ${item.title}`, item.agentId); return item;
    });
  });
  app.delete('/api/tasks/:id', async request => {
    const { id } = ids.parse(request.params); const { expectedVersion } = revision.parse(request.body);
    await store.update(state => { const item = state.tasks.find(item => item.id === id); if (!item) throw notFound(); checkVersion(item, expectedVersion); state.tasks = state.tasks.filter(item => item.id !== id); activity(state, `Deleted task: ${item.title}`, item.agentId); }); return { ok: true };
  });
  app.get('/api/usage', async request => {
    const { days, agentId } = z.object({ days: z.coerce.number().refine(value => [7, 30, 90].includes(value), 'Choose 7, 30, or 90 days.').default(30), agentId: z.string().min(1).max(300).optional() }).parse(request.query);
    const state = await store.read(); let agents = [] as Awaited<ReturnType<AgentProvider['listAgents']>>;
    try { agents = await provider.listAgents(); } catch { /* Recorded usage remains available while the runtime is offline. */ }
    return usageReport(state.runs, agents, days, agentId);
  });
}
