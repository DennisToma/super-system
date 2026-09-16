import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';
import { LegacyProvider, parseSse } from './legacy.js';
import { contentText, mapFile, mapMessage, mapRoutine, page } from './common.js';
import type { ProviderEvent, Run } from '@super-system/core';

const options = { mode: 'legacy' as const, baseUrl: 'https://letta.example.test', apiKey: 'private-test-token' };
const input = { runId: 'run-local', requestId: '7e9f6b69-3706-40dc-a3ac-2a0096307355', agentId: 'agent-existing', conversationId: 'agent-existing', message: 'Hello' };
const run = (fields: Partial<Run> = {}): Run => ({ id: input.runId, requestId: input.requestId, agentId: input.agentId, conversationId: input.conversationId, prompt: input.message, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), response: '', ...fields });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const stream = (...events: unknown[]) => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('configuration and redaction', () => {
  it('does not fabricate an agent or data when unconfigured', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const provider = createProvider({ mode: 'legacy' });
    expect((await provider.checkConnection()).status).toBe('unconfigured');
    await expect(provider.listAgents()).rejects.toMatchObject({ code: 'UNCONFIGURED', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['file:///etc/passwd', 'https://user:password@example.test', 'https://example.test?token=secret', 'garbage'])('rejects unsafe configuration %s', baseUrl => {
    expect(() => createProvider({ ...options, baseUrl })).toThrow(/URL|credentials/);
  });
  it('never returns an upstream error body or redirects credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private-test-token very secret', { status: 302, headers: { location: 'https://another.example.test' } })); vi.stubGlobal('fetch', fetch);
    const provider = createProvider(options); const result = await provider.checkConnection();
    expect(result.status).toBe('error'); expect(JSON.stringify(result)).not.toContain('private-test-token');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer private-test-token' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes definite authentication rejection from transport uncertainty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: options.apiKey }, 401)));
    await expect(createProvider(options).listAgents()).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`DNS request includes ${options.apiKey}`)));
    await expect(createProvider(options).listAgents()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('provider normalization', () => {
  it('maps multimodal text and excludes private reasoning', () => {
    expect(contentText([{ type: 'text', text: 'Visible' }, { type: 'image', source: {} }])).toBe('Visible');
    expect(mapMessage({ id: 'm', message_type: 'reasoning_message', reasoning: 'hidden' }, 'c')).toBeNull();
    expect(mapMessage({ id: 'm', message_type: 'tool_call_message', tool_call: { tool_call_id: 't', name: 'search', arguments: '{"q":"x"}' } }, 'c')?.toolCalls).toEqual([{ id: 't', name: 'search', arguments: '{"q":"x"}' }]);
  });
  it('maps actual file context state without guessing size', () => {
    expect(mapFile({ id: 'rel', file_id: 'file', file_name: 'notes.md', folder_name: 'Knowledge', is_open: false })).toMatchObject({ id: 'file', source: 'Knowledge', openInContext: false, size: undefined });
  });
  it('preserves cursor metadata and explicit terminal pages', () => {
    expect(page({ files: [{ id: 'a' }], next_cursor: 'next', has_more: true }, value => value, { limit: 1 }).nextCursor).toBe('next');
    expect(page({ files: [{ id: 'a' }], next_cursor: null }, value => value, { limit: 1 }).nextCursor).toBeUndefined();
    expect(page([{ id: 'a' }], value => value, { limit: 1 }).nextCursor).toBe('a');
  });
  it('maps the documented legacy schedule nesting and UTC semantics', () => {
    const routine = mapRoutine({ id: 's', agent_id: 'a', message: { messages: [{ role: 'user', content: 'Daily review' }] }, schedule: { type: 'recurring', cron_expression: '0 9 * * *' }, next_scheduled_time: '2026-09-17T09:00:00Z' }, 'a');
    expect(routine).toMatchObject({ prompt: 'Daily review', timezone: 'UTC', cron: '0 9 * * *', nextRunAt: '2026-09-17T09:00:00Z' });
  });
});

describe('legacy streaming lifecycle', () => {
  it('parses split UTF8, CRLF, comments and multiline data', async () => {
    const encoded = new TextEncoder().encode(': ping\r\ndata: {"text":\r\ndata: "Grüße"}\r\n\r\ndata: [DONE]\n\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < encoded.length; i += 3) controller.enqueue(encoded.slice(i, i + 3)); controller.close(); } });
    const events = []; for await (const item of parseSse(body)) events.push(item);
    expect(events).toEqual(['{"text":\n"Grüße"}', '[DONE]']);
  });
  it('streams text and run identity then records explicit completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream({ message_type: 'assistant_message', id: 'm', run_id: 'run-remote', content: 'Hello' }, { message_type: 'stop_reason', stop_reason: 'end_turn' }, '[DONE]')));
    const events: ProviderEvent[] = []; await createProvider(options).execute(input, async event => { events.push(event); });
    expect(events).toContainEqual({ type: 'text', text: 'Hello', messageId: 'm' });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'completed', providerRunId: 'run-remote' });
  });
  it('accumulates tool argument fragments under the original tool identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(
      { message_type: 'tool_call_message', id: 'm', tool_call: { tool_call_id: 'tool-a', name: 'search', arguments: '{"query":' } },
      { message_type: 'tool_call_message', id: 'm', tool_call: { arguments: '"memo"}' } },
      '[DONE]',
    )));
    const events: ProviderEvent[] = []; await createProvider(options).execute(input, async event => { events.push(event); });
    const calls = events.filter(event => event.type === 'tool_call');
    expect(calls.at(-1)).toMatchObject({ toolCall: { id: 'tool-a', name: 'search', arguments: '{"query":"memo"}' } });
  });
  it('leaves a truncated stream interrupted instead of inventing success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream({ message_type: 'assistant_message', id: 'm', content: 'Partial' })));
    const events: ProviderEvent[] = []; await createProvider(options).execute(input, async event => { events.push(event); });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'interrupted' });
  });
  it('waits for an explicit approval and continues the same run once', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stream({ message_type: 'approval_request_message', id: 'approval-1', tool_calls: [{ tool_call_id: 'tool-1', name: 'write_file', arguments: '{}' }] }, { message_type: 'stop_reason', stop_reason: 'requires_approval' }, '[DONE]')).mockResolvedValueOnce(stream({ message_type: 'assistant_message', id: 'm', content: 'Done' }, '[DONE]'));
    vi.stubGlobal('fetch', fetch); const provider = createProvider(options); const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'status', status: 'waiting_for_approval' })));
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.approve(run(), 'wrong-id', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    await provider.approve(run(), 'approval-1', false); await execution;
    const continuation = JSON.parse(fetch.mock.calls[1]?.[1].body);
    expect(continuation.messages[0]).toMatchObject({ type: 'approval', approve: false, approvals: [{ tool_call_id: 'tool-1', approve: false, type: 'approval' }] });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });
  it('does not expose provider errors in streamed events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream({ type: 'error', error: `Bearer ${options.apiKey}` })));
    const events: ProviderEvent[] = []; await createProvider(options).execute(input, async event => { events.push(event); });
    expect(JSON.stringify(events)).not.toContain(options.apiKey); expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });
});

describe('legacy capabilities and mutations', () => {
  it('keeps the existing agent default conversation on older servers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/v1/agents/' ? json([{ id: 'agent-existing', name: 'Memo' }]) : url.pathname.endsWith('blocks') ? json([]) : json({}, 404)));
    const provider = createProvider(options); const connection = await provider.checkConnection();
    expect(connection.capabilities.conversations.state).toBe('unsupported'); expect(connection.capabilities.memoryWrite.state).toBe('supported');
    expect((await provider.listConversations('agent-existing')).items).toEqual([{ id: 'agent-existing', agentId: 'agent-existing', title: 'Agent conversation' }]);
    await expect(provider.createConversation('agent-existing')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('requires a specific remote run id before cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/openapi.json' ? json({ paths: { '/v1/agents/{agent_id}/messages/cancel': { post: {} } } }) : url.pathname === '/v1/agents/' ? json([{ id: 'agent-existing' }]) : json([])));
    const provider = createProvider(options); await provider.checkConnection();
    await expect(provider.cancel(run())).rejects.toMatchObject({ code: 'CONFLICT' });
    await provider.cancel(run({ providerRunId: 'run-remote' }));
    const fetch = vi.mocked(globalThis.fetch); const final = fetch.mock.calls.at(-1)!;
    expect(JSON.parse(final[1]?.body as string)).toEqual({ run_ids: ['run-remote'] });
  });
  it('settles a cancelled approval waiter without submitting a denial continuation', async () => {
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname === '/openapi.json') return json({ paths: { '/v1/agents/{agent_id}/messages/cancel': { post: {} } } });
      if (url.pathname === '/v1/agents/') return json([{ id: 'agent-existing' }]);
      if (url.pathname.endsWith('/messages/stream')) return stream({ message_type: 'approval_request_message', id: 'approval-1', run_id: 'remote', tool_calls: [{ tool_call_id: 'tool-1', name: 'write_file', arguments: '{}' }] }, { message_type: 'stop_reason', stop_reason: 'requires_approval' }, '[DONE]');
      return json([]);
    });
    vi.stubGlobal('fetch', fetch);
    const provider = createProvider(options); await provider.checkConnection();
    const events: ProviderEvent[] = [];
    const execution = provider.execute(input, async event => { events.push(event); });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ status: 'waiting_for_approval' }));
    await provider.cancel(run({ providerRunId: 'remote' }));
    await execution;
    expect(events.at(-1)).toMatchObject({ status: 'cancelling' });
    expect(fetch.mock.calls.filter(call => call[0].pathname.endsWith('/messages/stream'))).toHaveLength(1);
    await provider.close();
  });
  it('updates only a block attached to the selected agent by its correct label', async () => {
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => init?.method === 'PATCH' ? json({ id: 'block-1', label: 'human/name', value: 'New' }) : json([{ id: 'block-1', label: 'human/name', value: 'Old' }])); vi.stubGlobal('fetch', fetch);
    const provider = new LegacyProvider(options);
    await expect(provider.updateMemory('agent-existing', 'foreign-block', 'New')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const result = await provider.updateMemory('agent-existing', 'block-1', 'New');
    expect(result.content).toBe('New'); expect((fetch.mock.calls.at(-1)![0] as URL).pathname).toContain('human%2Fname');
  });
  it('rejects non-UTC recurring schedules rather than silently shifting execution', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createProvider(options).createRoutine({ agentId: 'a', name: 'n', prompt: 'p', cron: '0 9 * * *', timezone: 'Europe/Vienna' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reconciles only by the known provider run and never resends', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ status: 'completed' })).mockResolvedValueOnce(json([{ id: 'm', message_type: 'assistant_message', content: 'Already done' }])); vi.stubGlobal('fetch', fetch);
    const provider = createProvider(options);
    expect(await provider.reconcile(run())).toBeNull();
    expect(await provider.reconcile(run({ providerRunId: 'remote' }))).toEqual({ status: 'completed', response: 'Already done' });
    expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true);
  });
});

describe('legacy transport shutdown and deadlines', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps the JSON body deadline active after response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('aborted'))); } }), { headers: { 'content-type': 'application/json' } })));
    const result = createProvider(options).listAgents().catch(error => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await result).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('uses stream inactivity rather than an absolute run deadline', async () => {
    vi.useFakeTimers(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } })));
    let settled = false;
    const result = createProvider(options).execute(input, async () => {}).catch(error => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
  it('closes local stream transport promptly without issuing remote cancellation', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => { signal = init.signal!; return new Response(new ReadableStream({ start() {} })); }); vi.stubGlobal('fetch', fetch);
    const provider = createProvider(options);
    const execution = provider.execute(input, async () => {}).catch(error => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await provider.close(); expect(signal!.aborted).toBe(true);
    expect(await execution).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0]![0])).toContain('/messages/stream');
  });
});
