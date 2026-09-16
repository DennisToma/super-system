import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, Run } from '@super-system/core';
const mocks = vi.hoisted(() => ({ client: {} as Record<string, any>, sessions: [] as any[], streams: [] as any[], commands: [] as any[], options: undefined as any, createRaw: undefined as any, rawClients: [] as any[], backend: 'cloud', messagePage: {} as any }));
vi.mock('@letta-ai/letta-agent-sdk/client', () => ({ LettaAgentClient: class {
  constructor(options: unknown) { mocks.options = options; Object.assign(this, mocks.client); }
} }));
vi.mock('@letta-ai/letta-code/app-server-client', () => ({ createAppServerClient: (options: unknown) => mocks.createRaw(options) }));
import { createProvider } from './index.js';
import { sdkEvent } from './app-server.js';

const input = { runId: 'app-run', requestId: '7e9f6b69-3706-40dc-a3ac-2a0096307355', agentId: 'agent-a', conversationId: 'conv-a', message: 'Hello' };
const run: Run = { id: input.runId, requestId: input.requestId, agentId: input.agentId, conversationId: input.conversationId, prompt: input.message, status: 'running', createdAt: '', updatedAt: '', response: '' };
const options = { mode: 'app-server' as const, baseUrl: 'https://letta.example.test/socket', serverToken: 'super-secret' };
beforeEach(() => {
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
          case 'app_server_info': result = response({ type: 'app_server_info_response', success: true, backend: mocks.backend, letta_code_version: '0.32.11', capabilities: { conversation_management: true, memory_management: true } }); break;
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
    agents: { list: vi.fn(async () => [{ id: 'agent-a', name: 'Memo' }]), retrieve: vi.fn(async () => ({ id: 'agent-a' })) },
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
