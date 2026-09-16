import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, Run } from '@super-system/core';
const mocks = vi.hoisted(() => ({ client: {} as Record<string, any>, sessions: [] as any[], streams: [] as any[], commands: [] as any[], mcp: undefined as any, options: undefined as any, createRaw: undefined as any, rawClients: [] as any[], mcpSupported: true, backend: 'cloud', messagePage: {} as any }));
vi.mock('@letta-ai/letta-agent-sdk/client', () => ({ LettaAgentClient: class {
  constructor(options: unknown) { mocks.options = options; Object.assign(this, mocks.client); }
} }));
vi.mock('@letta-ai/letta-code/app-server-client', () => ({ createAppServerClient: (options: unknown) => mocks.createRaw(options) }));
vi.mock('./mcp.js', async importOriginal => ({ ...await importOriginal<typeof import('./mcp.js')>(), connectMcp: (...args: any[]) => mocks.mcp(...args), testMcpConnection: vi.fn() }));
import { createProvider } from './index.js';
import { sdkEvent } from './app-server.js';

const input = { runId: 'app-run', requestId: '7e9f6b69-3706-40dc-a3ac-2a0096307355', agentId: 'agent-a', conversationId: 'conv-a', message: 'Hello' };
const run: Run = { id: input.runId, requestId: input.requestId, agentId: input.agentId, conversationId: input.conversationId, prompt: input.message, status: 'running', createdAt: '', updatedAt: '', response: '' };
const options = { mode: 'app-server' as const, baseUrl: 'https://letta.example.test/socket', serverToken: 'super-secret' };
beforeEach(() => {
  mocks.mcp = vi.fn(); mocks.mcpSupported = true;
  mocks.sessions = []; mocks.streams = []; mocks.commands = []; mocks.rawClients = [];
  mocks.backend = 'cloud'; mocks.messagePage = { messages: [], next_before: null, has_more: false };
  mocks.createRaw = vi.fn((rawOptions: unknown) => {
    let disconnect: (() => void) | undefined;
    const raw: any = {
      rawOptions,
      connect: vi.fn(async () => raw), close: vi.fn(),
      onDisconnect: vi.fn((callback) => { disconnect = callback; return () => { disconnect = undefined; }; }),
      disconnect: () => disconnect?.(),
      requestRaw: vi.fn(async (command, opts) => {
        mocks.commands.push(command);
        const response = (body: object) => ({ request_id: command.request_id, ...body });
        let result;
        switch (command.type) {
          case 'app_server_info': result = response({ type: 'app_server_info_response', success: true, backend: mocks.backend, letta_code_version: '0.32.11', capabilities: { agent_management: true, conversation_management: true, memory_management: true, runtime_start: true, runtime_external_tools_update: mocks.mcpSupported, split_channels: false, auth_token: 'super-secret' } }); break;
          case 'conversation_messages_list': result = response({ type: 'conversation_messages_list_response', success: true, ...mocks.messagePage }); break;
          case 'list_memory': {
            // Cross-request and cross-command frames must not enter the accumulator.
            expect(opts.predicate({ type: 'list_memory_response', request_id: 'another-client', entries: [{ relative_path: 'foreign.md' }], done: true })).toBe(false);
            expect(opts.predicate({ type: 'cron_list_response', request_id: command.request_id, entries: [{ relative_path: 'foreign.md' }], done: true })).toBe(false);
            expect(opts.predicate(response({ type: 'list_memory_response', success: true, entries: [{ relative_path: 'system/persona.md', content: 'First', is_system: true }], done: false }))).toBe(false);
            result = response({ type: 'list_memory_response', success: true, entries: [{ relative_path: 'notes.md', content: 'Second', is_system: false }], done: true, memfs_enabled: true }); break;
          }
          case 'cron_list': result = response({ type: 'cron_list_response', success: true, tasks: [{ id: 'routine-a', agent_id: 'agent-a', name: 'Review', prompt: 'Review', cron: '0 9 * * *', timezone: 'Europe/Vienna', status: 'active' }] }); break;
          case 'cron_add': result = response({ type: 'cron_add_response', success: true, task: { ...command, id: 'routine-b', status: 'active' } }); break;
          case 'cron_pause': result = response({ type: 'cron_pause_response', success: true, found: true }); break;
          case 'cron_trigger': result = response({ type: 'cron_trigger_response', success: true, found: true }); break;
          default: result = response({ type: `${command.type}_response`, success: true });
        }
        expect(opts.predicate(result)).toBe(true); return result;
      }),
    };
    mocks.rawClients.push(raw); return raw;
  });
  mocks.client = {
    agents: { update: vi.fn(async (_id, patch) => ({ id: 'agent-a', ...patch })), list: vi.fn(async () => [{ id: 'agent-a', name: 'Memo' }]), retrieve: vi.fn(async () => ({ id: 'agent-a' })) },
    conversations: { list: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'conv-a', agent_id: 'agent-a' })) },
    close: vi.fn(async () => {}),
    resumeSession: vi.fn((id, sessionOptions = {}) => {
      const session = {
        sessionOptions,
        ready: vi.fn(async () => ({ agentId: 'agent-a', conversationId: id.startsWith('conv-') ? id : 'conv-default' })),
        send: vi.fn(async () => {}), close: vi.fn(), abort: vi.fn(async () => {}),
        stream: vi.fn(async function* () { for (const event of mocks.streams) yield event; }),
      };
      mocks.sessions.push(session); return session;
    }),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('remote App Server integration', () => {
  it('omits authentication when an SSH-only endpoint has blank environment tokens', async () => {
    const provider = createProvider({ ...options, serverToken: '', apiKey: '', agentId: '' });
    const connection = await provider.checkConnection();
    expect(mocks.options.authToken).toBeUndefined();
    expect(mocks.rawClients[0].rawOptions.authToken).toBeUndefined();
    expect(connection.version).toBe('0.32.11');
    expect(connection.capabilities.memoryRead.state).toBe('supported');
    await provider.close();
  });
  it('connects remotely with a server-only token and discovers real command support', async () => {
    const provider = createProvider(options); const connection = await provider.checkConnection();
    expect(mocks.options).toMatchObject({ backend: 'remote', url: 'wss://letta.example.test/socket', authToken: 'super-secret' });
    expect(connection.version).toBe('0.32.11'); expect(connection.capabilities.routineRun.state).toBe('supported'); expect(JSON.stringify(connection)).not.toContain('super-secret');
    expect(connection.capabilities.machines.state).toBe('unsupported');
    await expect(provider.listMachines()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    expect(mocks.createRaw).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://letta.example.test/socket', authToken: 'super-secret' }));
    await provider.close(); expect(mocks.rawClients[0].close).toHaveBeenCalled();
  });
  it('collects every chunk of MemFS data and labels files as provider memory', async () => {
    const provider = createProvider(options);
    const memory = await provider.listMemory('agent-a'); expect(memory.items.map(item => item.title)).toEqual(['system/persona.md', 'notes.md']);
    expect((await provider.listMemory('agent-a', { query: 'second' })).items).toHaveLength(1);
    expect((await provider.listFiles('agent-a')).items[1]).toMatchObject({ source: 'Agent MemFS', openInContext: false });
    await expect(provider.updateMemory('agent-a', '../outside', 'Bad')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('performs resource reads and scheduling without runtime starts or approval handlers', async () => {
    const provider = createProvider(options);
    await provider.checkConnection(); await provider.listMemory('agent-a'); await provider.listFiles('agent-a');
    await provider.listConversations('agent-a'); await provider.listMessages('conv-a', 'agent-a');
    await provider.listRoutines('agent-a'); await provider.pauseRoutine('agent-a', 'routine-a', true);
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    expect(mocks.commands.every(command => !['runtime_start', 'input', 'control_response', 'sync'].includes(command.type))).toBe(true);
    expect(new Set(mocks.commands.map(command => command.request_id)).size).toBe(mocks.commands.length);
    expect(mocks.createRaw).toHaveBeenCalledTimes(1); await provider.close();
  });
  it('discards disconnected management sockets and reconnects the next request', async () => {
    const provider = createProvider(options); await provider.listMemory('agent-a');
    mocks.rawClients[0].disconnect(); await provider.listRoutines('agent-a');
    expect(mocks.createRaw).toHaveBeenCalledTimes(2); expect(mocks.rawClients[0].close).toHaveBeenCalled();
    await provider.close(); expect(mocks.rawClients[1].close).toHaveBeenCalled();
  });
  it('includes local default history once without starting a runtime or creating a conversation', async () => {
    mocks.backend = 'local';
    mocks.client.conversations.list.mockResolvedValue([{ id: 'conv-a', agent_id: 'agent-a', summary: 'Named conversation' }]);
    const provider = createProvider(options);
    const first = await provider.listConversations('agent-a', { limit: 1 });
    expect(first.items.map(item => item.id)).toEqual(['agent-a', 'conv-a']);
    expect(first.items[0].title).toBe('Default conversation');
    expect(first.nextCursor).toBe('conv-a');
    expect((await provider.listConversations('agent-a', { limit: 1, cursor: first.nextCursor })).items.map(item => item.id)).toEqual(['conv-a']);
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    expect(mocks.client.conversations.create).not.toHaveBeenCalled();
    await provider.close();
  });
  it('scopes default history to its agent and preserves server pagination through filtered pages', async () => {
    mocks.messagePage = { messages: [{ id: 'hidden', message_type: 'reasoning_message', reasoning: 'private' }], next_before: 'older', has_more: true };
    const provider = createProvider(options);
    expect(await provider.listMessages('agent-a', 'agent-a', { limit: 1 })).toEqual({ items: [], nextCursor: 'older' });
    expect(mocks.commands.at(-1)).toMatchObject({ type: 'conversation_messages_list', conversation_id: 'default', query: { agent_id: 'agent-a', limit: 1, order: 'desc' } });
    mocks.messagePage = { messages: [{ id: 'm', message_type: 'assistant_message', content: 'Older text' }], next_before: 'm', has_more: false };
    const last = await provider.listMessages('agent-a', 'agent-a', { limit: 1, cursor: 'older' });
    expect(last.items[0]).toMatchObject({ conversationId: 'agent-a', content: 'Older text' });
    expect(last.nextCursor).toBeUndefined();
    expect(mocks.commands.at(-1).query).toMatchObject({ agent_id: 'agent-a', before: 'older' });
    await provider.listMessages('agent-b', 'agent-b');
    expect(mocks.commands.at(-1).query.agent_id).toBe('agent-b');
    await provider.listMessages('conv-a', 'agent-a');
    expect(mocks.commands.at(-1).conversation_id).toBe('conv-a');
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
  it('resumes an existing agent default session while keeping its application conversation ID', async () => {
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = vi.fn((id, opts) => {
      const session = original(id, opts);
      session.ready = async () => ({ agentId: 'agent-a', conversationId: 'default' });
      return session;
    });
    mocks.streams = [{ type: 'result', success: true, result: 'Connected' }];
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    await provider.execute({ ...input, conversationId: 'agent-a' }, async event => { events.push(event); });
    expect(mocks.client.resumeSession).toHaveBeenCalledWith('agent-a', expect.any(Object));
    expect(mocks.sessions[0].send).toHaveBeenCalledWith('Hello', { otid: input.requestId });
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    await provider.close();
  });
  it('sends timezone and the exact schedule to a verified runtime', async () => {
    const provider = createProvider(options); await provider.checkConnection();
    const routine = await provider.createRoutine({ agentId: 'agent-a', name: 'Morning', prompt: 'Review notes', cron: '0 9 * * *', timezone: 'Europe/Vienna' });
    expect(mocks.commands.at(-1)).toMatchObject({ type: 'cron_add', timezone: 'Europe/Vienna', cron: '0 9 * * *', recurring: true });
    expect(routine.timezone).toBe('Europe/Vienna');
    await expect(provider.runRoutine('agent-a', 'foreign')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await provider.pauseRoutine('agent-a', 'routine-a', true); expect(mocks.commands.at(-1).type).toBe('cron_pause');
  });
  it('streams typed text once, deduplicates replay, and ignores the repeated final result', async () => {
    mocks.streams = [{ type: 'assistant', content: 'Hello', uuid: 'm', runId: 'r', seqId: 1 }, { type: 'assistant', content: 'Hello', uuid: 'm', runId: 'r', seqId: 1 }, { type: 'result', success: true, result: 'Hello', runIds: ['r'] }];
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    await provider.execute(input, async event => { events.push(event); });
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'Hello', messageId: 'm' }]);
    expect(events.at(-1)).toMatchObject({ status: 'completed', providerRunId: 'r' });
    expect(mocks.sessions[0].send).toHaveBeenCalledWith('Hello', { otid: input.requestId });
  });
  it('holds standard-mode tool approval until the operator decides', async () => {
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        const decision = await opts.canUseTool('Write', { path: 'notes.md' }, { requestId: 'approval-1' });
        expect(decision.behavior).toBe('deny'); yield { type: 'result', success: true, result: 'No changes made' };
      }; return session;
    };
    const events: ProviderEvent[] = []; const provider = createProvider(options); const execution = provider.execute(input, async event => { events.push(event); });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'waiting_for_approval' })));
    expect(mocks.sessions[0].sessionOptions.permissionMode).toBe('standard');
    await provider.approve(run, 'approval-1', false); await execution;
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
  });
  it('sets cancellation intent before the abort response can race its terminal event', async () => {
    let resolveResult: (value: any) => void;
    const result = new Promise(resolve => { resolveResult = resolve; }); const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () { yield await result; };
      session.abort = async () => { resolveResult({ type: 'result', success: false, errorCode: 'interrupted' }); await new Promise(resolve => setTimeout(resolve, 1)); };
      return session;
    };
    const events: ProviderEvent[] = []; const provider = createProvider(options); const execution = provider.execute(input, async event => { events.push(event); });
    await vi.waitFor(() => expect(mocks.sessions[0].send).toHaveBeenCalled());
    await provider.cancel(run); await execution;
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  });
  it('does not send the prompt when cancellation arrives during session initialization', async () => {
    let resolveReady!: (value: unknown) => void;
    const ready = new Promise(resolve => { resolveReady = resolve; }); const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts); session.ready = () => ready; return session;
    };
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    const execution = provider.execute(input, async event => { events.push(event); });
    await provider.cancel(run);
    resolveReady({ agentId: 'agent-a', conversationId: 'conv-a' }); await execution;
    expect(mocks.sessions[0].send).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });
  it('presents simultaneous approval requests separately and applies each decision once', async () => {
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        const decisions = await Promise.all([
          opts.canUseTool('Write', { path: 'one.md' }, { requestId: 'approval-one' }),
          opts.canUseTool('Write', { path: 'two.md' }, { requestId: 'approval-two' }),
        ]);
        expect(decisions.map((decision: any) => decision.behavior)).toEqual(['allow', 'deny']);
        yield { type: 'result', success: true };
      }; return session;
    };
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    const execution = provider.execute(input, async event => { events.push(event); });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'approval')).toHaveLength(1));
    await provider.approve(run, 'approval-one', true);
    expect(events.filter(event => event.type === 'approval')).toHaveLength(2);
    await expect(provider.approve(run, 'approval-one', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    await provider.approve(run, 'approval-two', false); await execution;
  });
  it('never invents terminal completion from historical assistant text after restart', async () => {
    mocks.messagePage = { messages: [{ id: 'm', message_type: 'assistant_message', run_id: 'remote', content: 'Partial reply' }], has_more: false };
    const provider = createProvider(options);
    expect(await provider.reconcile({ ...run, providerRunId: 'remote' })).toEqual({ status: 'interrupted', response: 'Partial reply' });
    expect(await provider.reconcile({ ...run, conversationId: 'agent-a', providerRunId: 'remote' })).toEqual({ status: 'interrupted', response: 'Partial reply' });
    expect(mocks.commands.at(-1)).toMatchObject({ conversation_id: 'default', query: { agent_id: 'agent-a' } });
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
  });
  it('sanitizes SDK errors and does not expose internal reasoning', () => {
    expect(sdkEvent({ type: 'error', message: 'Bearer super-secret', stopReason: 'error' })?.type).toBe('error');
    expect(JSON.stringify(sdkEvent({ type: 'error', message: 'Bearer super-secret', stopReason: 'error' }))).not.toContain('super-secret');
    expect(sdkEvent({ type: 'reasoning', content: 'private', uuid: 'r' })).toBeNull();
  });
});


describe('control room management and usage', () => {
  it('projects configuration and rejects stale updates without attaching a runtime', async () => {
    const raw = { id: 'agent-a', name: 'Memo', description: 'Assistant', model: 'openai/gpt-5', system: 'Be helpful', api_key: 'super-secret', tools: [{ token: 'super-secret' }] };
    mocks.client.agents.retrieve.mockResolvedValue(raw);
    const provider = createProvider(options);
    const config = await provider.getAgentConfiguration!('agent-a');
    expect(config).toEqual({ agentId: 'agent-a', name: 'Memo', description: 'Assistant', model: 'openai/gpt-5', system: 'Be helpful', version: expect.any(String), editableFields: ['name', 'description', 'model', 'system'] });
    expect(JSON.stringify(config)).not.toContain('super-secret');
    await expect(provider.updateAgentConfiguration!('agent-a', { name: 'New', expectedVersion: 'old' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.client.agents.update).not.toHaveBeenCalled();
    await provider.updateAgentConfiguration!('agent-a', { name: 'New', expectedVersion: config.version });
    expect(mocks.client.agents.update).toHaveBeenCalledWith('agent-a', { name: 'New' });
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
  it('reports only exact supported gateway flags and no secrets', async () => {
    const provider = createProvider(options);
    expect(await provider.getGatewayRuntime!()).toEqual({ backend: 'cloud', version: '0.32.11', capabilities: { agent_management: true, conversation_management: true, memory_management: true, runtime_start: true, runtime_external_tools_update: true, split_channels: false } });
    const connection = await provider.checkConnection();
    expect(connection.capabilities.agentConfigWrite.state).toBe('supported');
    expect(connection.capabilities.mcp.state).toBe('supported');
    expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
  it('prepends only supplied skills and sums measured usage before completion', async () => {
    mocks.streams = [
      { type: 'stream_event', event: { message_type: 'usage_statistics', prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, run_id: 'r', seq_id: 1 } },
      { type: 'stream_event', event: { message_type: 'usage_statistics', prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, run_id: 'r', seq_id: 1 } },
      { type: 'stream_event', event: { message_type: 'usage_statistics', prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, run_id: 'r', seq_id: 2 } },
      { type: 'result', success: true, durationMs: 125, totalCostUsd: 0.01, prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    ];
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    await provider.execute(input, async event => { events.push(event); }, { skills: [{ name: 'Writing', content: 'Use simple words.' }], mcpServers: [] });
    expect(mocks.sessions[0].send.mock.calls[0][0]).toContain('Use simple words.');
    expect(mocks.sessions[0].send.mock.calls[0][0]).toMatch(/Hello$/);
    expect(input.message).toBe('Hello');
    expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20, durationMs: 125, costUsd: 0.01 } });
    expect(events.at(-1)).toMatchObject({ status: 'completed' });
    await provider.close();
  });
  it('does not invent missing token, cost, or duration measurements', async () => {
    mocks.streams = [{ type: 'stream_event', event: { message_type: 'usage_statistics', prompt_tokens: -1, completion_tokens: null, total_tokens: NaN } }, { type: 'result', success: true }];
    const events: ProviderEvent[] = []; const provider = createProvider(options);
    await provider.execute(input, async event => { events.push(event); });
    expect(events.filter(event => event.type === 'usage')).toEqual([]);
    await provider.close();
  });
});


describe('application MCP execution gate', () => {
  const resources = { skills: [], mcpServers: [{ name: 'workspace', transport: 'http' as const, url: 'https://tools.test/mcp' }] };
  it.each([[true, true], [true, false], [false, true], [false, false]])('requires one execution-time approval when approved=%s and SDK asks=%s', async (approved, sdkAsks) => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'Done' }] })); const close = vi.fn(async () => {});
    mocks.mcp.mockResolvedValue({ tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }], callTool, close });
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        const tool = opts.tools[0];
        if (sdkAsks) {
          const permission = await opts.canUseTool(tool.name, { path: 'one.md' }, { requestId: 'sdk-permission' });
          expect(permission.behavior).toBe('allow');
        }
        const result = await tool.execute('mcp-call', { path: 'one.md' });
        expect(result.isError).toBe(approved ? undefined : true);
        yield { type: 'result', success: true };
      }; return session;
    };
    const provider = createProvider(options); await provider.checkConnection(); const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); }, resources);
    await vi.waitFor(() => expect(events.filter(event => event.type === 'approval')).toHaveLength(1));
    expect(callTool).not.toHaveBeenCalled();
    const approval = events.find(event => event.type === 'approval')!;
    if (approval.type !== 'approval') throw new Error();
    await provider.approve(run, approval.approval.id, approved); await execution;
    expect(callTool).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.sessions[0].sessionOptions.mcpServers).toBeUndefined();
    await provider.close();
  });
  it('cancellation denies a pending MCP approval and closes its connection', async () => {
    const callTool = vi.fn(); const close = vi.fn(async () => {});
    mocks.mcp.mockResolvedValue({ tools: [{ name: 'write_file', inputSchema: { type: 'object' } }], callTool, close });
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        expect((await opts.tools[0].execute('mcp-call', {})).isError).toBe(true);
        yield { type: 'result', success: false, errorCode: 'interrupted' };
      }; return session;
    };
    const provider = createProvider(options); await provider.checkConnection(); const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); }, resources);
    await vi.waitFor(() => expect(events.some(event => event.type === 'approval')).toBe(true));
    await provider.cancel(run); await execution;
    expect(callTool).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
    await provider.close();
  });
});


describe('MCP startup failure cleanup', () => {
  it('closes already opened servers when a later connection fails before runtime attachment', async () => {
    const close = vi.fn(async () => {});
    mocks.mcp.mockResolvedValueOnce({ tools: [], close }).mockRejectedValueOnce(new Error('connection failed'));
    const provider = createProvider(options); await provider.checkConnection();
    await expect(provider.execute(input, async () => {}, { skills: [], mcpServers: [
      { name: 'one', transport: 'http', url: 'https://one.test' }, { name: 'two', transport: 'http', url: 'https://two.test' },
    ] })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(close).toHaveBeenCalledTimes(1); expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
  it('cancels initialization and never sends a prompt after a late connection resolves', async () => {
    let resolve!: (value: any) => void; const close = vi.fn(async () => {});
    mocks.mcp.mockImplementation(() => new Promise(done => { resolve = done; }));
    const provider = createProvider(options); await provider.checkConnection(); const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); }, { skills: [], mcpServers: [{ name: 'one', transport: 'http', url: 'https://one.test' }] });
    await provider.cancel(run); resolve({ tools: [], close }); await execution;
    expect(close).toHaveBeenCalledTimes(1); expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
    await provider.close();
  });
});


describe('MCP event integrity and capability boundaries', () => {
  it('redacts content while preserving event types, statuses, IDs, and numeric usage', async () => {
    const resources = { skills: [], mcpServers: [{ name: 'fixture', transport: 'stdio' as const, command: 'node', env: { MODE: 'running', ONE: '1', TYPE: 'text' } }] };
    mocks.mcp.mockResolvedValue({ tools: [], close: vi.fn(async () => {}) });
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        const decision = await opts.canUseTool('text_tool', { value: 'running text 1' }, { requestId: 'approval-1', blockedPath: 'text/1' });
        expect(decision.behavior).toBe('allow');
        yield { type: 'assistant', uuid: 'message-1', content: 'running text 1', runId: 'running-1', seqId: 1 };
        yield { type: 'tool_call', toolCallId: 'call-1', toolName: 'text_tool', toolInput: { value: 'running text 1' }, runId: 'running-1', seqId: 2 };
        yield { type: 'tool_result', toolCallId: 'call-1', content: 'running text 1', isError: true, runId: 'running-1', seqId: 3 };
        yield { type: 'stream_event', event: { message_type: 'usage_statistics', prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        yield { type: 'result', success: true, durationMs: 1, totalCostUsd: 1, runIds: ['running-1'] };
      }; return session;
    };
    const provider = createProvider(options); await provider.checkConnection(); const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); }, resources);
    await vi.waitFor(() => expect(events.some(event => event.type === 'approval')).toBe(true));
    const approval = events.find(event => event.type === 'approval');
    expect(approval).toEqual({ type: 'approval', approval: { id: 'approval-1', toolName: '[redacted]_tool', arguments: '{"value":"[redacted] [redacted] [redacted]"}', description: 'Requested access: [redacted]/[redacted]' } });
    await provider.approve(run, 'approval-1', true); await execution;
    expect(events).toContainEqual({ type: 'text', text: '[redacted] [redacted] [redacted]', messageId: 'message-1' });
    expect(events).toContainEqual({ type: 'status', status: 'running', providerRunId: 'running-1' });
    expect(events).toContainEqual({ type: 'tool_call', toolCall: { id: 'call-1', name: '[redacted]_tool', arguments: '{"value":"[redacted] [redacted] [redacted]"}', status: 'running' } });
    expect(events).toContainEqual({ type: 'tool_result', toolCallId: 'call-1', content: '[redacted] [redacted] [redacted]', isError: true });
    expect(events.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1, costUsd: 1 } });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'completed', providerRunId: 'running-1' });
    await provider.close();
  });
  it.each([false, undefined])('rejects MCP resources before connecting when runtime support is %s', async supported => {
    mocks.mcpSupported = supported as any;
    mocks.mcp.mockResolvedValue({ tools: [], close: vi.fn(async () => {}) });
    const provider = createProvider(options); await provider.checkConnection();
    await expect(provider.execute(input, async () => {}, { skills: [], mcpServers: [{ name: 'fixture', transport: 'stdio', command: 'node' }] })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mocks.mcp).not.toHaveBeenCalled(); expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
  it('rejects MCP resources before connecting until capabilities have been checked', async () => {
    mocks.mcp.mockResolvedValue({ tools: [], close: vi.fn(async () => {}) });
    const provider = createProvider(options);
    await expect(provider.execute(input, async () => {}, { skills: [], mcpServers: [{ name: 'fixture', transport: 'stdio', command: 'node' }] })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mocks.mcp).not.toHaveBeenCalled(); expect(mocks.client.resumeSession).not.toHaveBeenCalled();
    await provider.close();
  });
});

describe('MCP cancellation and late decisions', () => {
  it('keeps a cancelled call denied when an earlier approval is still persisting its running event', async () => {
    const callTool = vi.fn(async () => ({ content: [] })); const close = vi.fn(async () => {});
    mocks.mcp.mockResolvedValue({ tools: [{ name: 'write_file', inputSchema: { type: 'object' } }], callTool, close });
    const original = mocks.client.resumeSession;
    mocks.client.resumeSession = (id: string, opts: any) => {
      const session = original(id, opts);
      session.stream = async function* () {
        expect((await opts.tools[0].execute('call-1', {})).isError).toBe(true);
        yield { type: 'result', success: false, errorCode: 'interrupted' };
      }; return session;
    };
    const provider = createProvider(options); await provider.checkConnection();
    const events: ProviderEvent[] = []; let holdRunning = false; let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const execution = provider.execute(input, async event => {
      events.push(event);
      if (holdRunning && event.type === 'status' && event.status === 'running') await paused;
    }, { skills: [], mcpServers: [{ name: 'fixture', transport: 'http', url: 'https://tools.test' }] });
    await vi.waitFor(() => expect(events.some(event => event.type === 'approval')).toBe(true));
    const approval = events.find(event => event.type === 'approval'); if (approval?.type !== 'approval') throw new Error();
    holdRunning = true;
    const decision = provider.approve(run, approval.approval.id, true);
    await provider.cancel(run);
    await expect(provider.approve(run, approval.approval.id, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    release(); await decision; await execution;
    expect(callTool).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
    await provider.close();
  });
});
