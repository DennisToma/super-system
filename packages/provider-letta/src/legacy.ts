import { ProviderError, unsupported, type AgentConfigPatch, type AgentConfiguration, type AgentProvider, type RunResources, type UsageMeasurement, type Approval, type CapabilityKey, type CreateRoutineInput, type EmitEvent, type ListOptions, type Page, type Run, type StartRunInput, type Conversation, type MemoryItem } from '@super-system/core';
import { array, contentText, filteredPage, limitOf, mapAgent, mapConversation, mapFile, mapMemory, mapMessage, mapRoutine, mergeToolCall, page, ProviderBase, record, remoteStatus, requiredId, safeUrl, sanitizeError, str, type ProviderOptions, type RecordValue } from './common.js';

import { addUsage, configuration, configurationPatch, ConfigurationWrites, resourcePrompt } from './management.js';

/** Parse SSE across arbitrary transport chunks, including CRLF and multiline data. */
export async function* parseSse(body: ReadableStream<Uint8Array>, onChunk?: () => void, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new ProviderError('PROVIDER_UNAVAILABLE', 'The Letta stream was disconnected or stopped responding. Reconcile the run before sending again.', 503);
      if (value) onChunk?.();
      buffer += decoder.decode(value, { stream: !done });
      // CRLF may be split across chunks, so only normalize complete event boundaries.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 4_000_000) throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned an oversized streaming event.', 502);
      if (done) break;
    }
    // An incomplete trailing frame is not a terminal response.
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
interface PendingApproval { id: string; resolve: (approved: boolean | 'cancel-requested') => void }
export class LegacyProvider extends ProviderBase implements AgentProvider {
  private readonly configurationWrites = new ConfigurationWrites();
  private configEditable: AgentConfiguration['editableFields'] = [];
  private readonly base: string;
  private conversationsAvailable = false;
  private paths: RecordValue = {};
  private pending = new Map<string, PendingApproval>();
  private shuttingDown = false;
  private readonly controllers = new Set<AbortController>();
  private readonly responses = new WeakMap<Response, { controller: AbortController; touch: () => void; finish: () => void }>();
  constructor(options: ProviderOptions) {
    super(options); this.base = safeUrl(options).toString().replace(/\/$/, '').replace(/\/v1$/, '');
    this.support(['machines', 'routineRun', 'routinePause', 'gateway', 'mcp', 'agentConfigWrite'], 'unsupported', 'This operation is not exposed by the legacy Letta REST API.');
  }
  private async request(path: string, init: RequestInit = {}, query: Record<string, string | number | undefined> = {}, stream = false): Promise<Response> {
    const url = new URL(`${this.base}${path}`); for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController(); this.controllers.add(controller);
    const duration = stream ? 60_000 : 15_000; let timeout = setTimeout(() => controller.abort(), duration);
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), duration); };
    const finish = () => { clearTimeout(timeout); this.controllers.delete(controller); };
    const token = this.options.apiKey || this.options.serverToken;
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal, headers: { Accept: stream ? 'text/event-stream' : 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new ProviderError('PROVIDER_REJECTED', 'Letta rejected the configured credentials or permissions.', 502);
        if ([404, 405, 501].includes(response.status)) throw new ProviderError('UNSUPPORTED', 'This resource or operation is not available on the connected Letta server.', 501);
        if (response.status >= 400 && response.status < 500) throw new ProviderError('PROVIDER_REJECTED', `Letta rejected this request (HTTP ${response.status}). Check its configuration and input.`, 502);
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'The Letta server could not complete the request.', 503);
      }
      this.responses.set(response, { controller, touch, finish });
      return response;
    } catch (error) { finish(); throw sanitizeError(error); }
  }
  private async json(path: string, init?: RequestInit, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const response = await this.request(path, init, query);
    try { if (response.status === 204) return null; return await response.json(); }
    catch (error) { if (this.responses.get(response)?.controller.signal.aborted) throw new ProviderError('PROVIDER_UNAVAILABLE', 'The Letta response timed out or the connection closed.', 503); throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned an unreadable response.', 502); }
    finally { this.responses.get(response)?.finish(); }
  }
  private advertised(path: string, method: string) { return Boolean(record(this.paths[path])[method]); }
  private async probe(path: string, keys: CapabilityKey[], query?: Record<string, string | number | undefined>) {
    try { await this.json(path, undefined, query); this.support(keys, 'supported'); return true; }
    catch (error) { const e = sanitizeError(error); this.support(keys, e.code === 'UNSUPPORTED' ? 'unsupported' : 'unavailable', e.message); return false; }
  }
  async checkConnection() {
    const started = Date.now();
    try {
      const agents = await this.listAgents();
      try {
        const spec = record(await this.json('/openapi.json')); this.paths = record(spec.paths);
        const resolve = (value: unknown): RecordValue => {
          const schema = record(value); const ref = str(schema.$ref);
          return ref?.startsWith('#/components/schemas/') ? record(record(record(spec.components).schemas)[ref.slice('#/components/schemas/'.length)]) : schema;
        };
        const patch = record(record(this.paths['/v1/agents/{agent_id}']).patch);
        const body = record(record(record(patch.requestBody).content)['application/json']);
        const fields = record(resolve(body.schema).properties);
        this.configEditable = (['name', 'description', 'system'] as const).filter(key => Object.hasOwn(fields, key));
      } catch { this.paths = {}; this.configEditable = []; }
      const agentId = this.options.agentId ?? agents[0]?.id;
      this.support(['chat', 'approvals'], 'supported');
      this.conversationsAvailable = await this.probe('/v1/conversations/', ['conversations'], { agent_id: agentId, limit: 1 });
      if (agentId) {
        await this.probe(`/v1/agents/${encodeURIComponent(agentId)}`, ['agentConfigRead']);
        this.support(['agentConfigWrite'], this.configEditable.length ? 'supported' : 'unsupported', this.configEditable.length ? undefined : 'This server does not advertise supported configuration fields.');
        await Promise.all([
          this.probe(`/v1/agents/${encodeURIComponent(agentId)}/core-memory/blocks`, ['memoryRead', 'memoryWrite']),
          this.probe(`/v1/agents/${encodeURIComponent(agentId)}/files`, ['files'], { limit: 1 }),
          this.probe(`/v1/agents/${encodeURIComponent(agentId)}/schedule`, ['routinesRead', 'routinesWrite'], { limit: 1 }),
        ]);
      }
      const cancel = this.advertised('/v1/agents/{agent_id}/messages/cancel', 'post');
      this.support(['cancel'], cancel ? 'supported' : 'unsupported', cancel ? undefined : 'This server does not advertise a remote cancellation endpoint.');
      return this.connection('connected', { latencyMs: Date.now() - started });
    } catch (error) {
      this.support(['chat', 'conversations', 'cancel', 'approvals', 'memoryRead', 'memoryWrite', 'files', 'routinesRead', 'routinesWrite', 'agentConfigRead', 'agentConfigWrite'], 'unavailable', sanitizeError(error).message);
      return this.connection('error', { error: sanitizeError(error).message, latencyMs: Date.now() - started });
    }
  }
  async getAgentConfiguration(agentId: string) {
    return configuration(await this.json(`/v1/agents/${encodeURIComponent(agentId)}`), this.configEditable);
  }
  async updateAgentConfiguration(agentId: string, patch: AgentConfigPatch) {
    if (!this.configEditable.length) unsupported('Changing agent configuration on this legacy server');
    return this.configurationWrites.run(agentId, async () => {
      const fields = configurationPatch(patch, await this.getAgentConfiguration(agentId));
      return configuration(await this.json(`/v1/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: JSON.stringify(fields) }), this.configEditable);
    });
  }
  async getGatewayRuntime() { return unsupported('Gateway runtime diagnostics'); }
  async listAgents() {
    if (this.options.agentId) return [mapAgent(await this.json(`/v1/agents/${encodeURIComponent(this.options.agentId)}`))];
    const agents = []; let after: string | undefined; const seen = new Set<string>();
    for (;;) {
      const rows = array(await this.json('/v1/agents/', undefined, { limit: 100, after }));
      for (const row of rows) { const a = mapAgent(row); if (!seen.has(a.id)) { agents.push(a); seen.add(a.id); } }
      const next = str(record(rows.at(-1)).id); if (rows.length < 100 || !next || next === after) break; after = next;
    }
    return agents;
  }
  async listConversations(agentId: string, options?: ListOptions): Promise<Page<Conversation>> {
    if (!this.conversationsAvailable) return { items: options?.cursor ? [] : [{ id: agentId, agentId, title: 'Agent conversation' }] };
    return page(await this.json('/v1/conversations/', undefined, { agent_id: agentId, limit: limitOf(options), after: options?.cursor, order: 'desc' }), value => mapConversation(value, agentId), options);
  }
  async createConversation(agentId: string, title?: string) {
    if (!this.conversationsAvailable) unsupported('Creating separate conversations');
    return mapConversation(await this.json('/v1/conversations/', { method: 'POST', body: JSON.stringify({ agent_id: agentId, ...(title ? { summary: title } : {}) }) }), agentId);
  }
  async listMessages(conversationId: string, agentId: string, options?: ListOptions) {
    const path = conversationId === agentId ? `/v1/agents/${encodeURIComponent(agentId)}/messages` : `/v1/conversations/${encodeURIComponent(conversationId)}/messages`;
    const raw = await this.json(path, undefined, { before: options?.cursor, limit: limitOf(options), order: 'desc' });
    const mapped = page(raw, value => mapMessage(value, conversationId), options);
    return { ...mapped, items: mapped.items.filter(item => item !== null).reverse() };
  }
  async execute(input: StartRunInput, emit: EmitEvent, resources?: RunResources) {
    if (resources?.mcpServers.length) unsupported('Application-owned MCP tools on the legacy REST transport');
    const usage: UsageMeasurement = {};
    let usageEmitted = false;
    const emitUsage = async () => { if (!usageEmitted && Object.keys(usage).length) { usageEmitted = true; await emit({ type: 'usage', usage: { ...usage } }); } };
    if (input.conversationId !== input.agentId) {
      const conversation = record(await this.json(`/v1/conversations/${encodeURIComponent(input.conversationId)}`));
      if (conversation.agent_id !== input.agentId) throw new ProviderError('PROVIDER_REJECTED', 'The conversation does not belong to the selected agent.', 409);
    }
    const path = input.conversationId === input.agentId ? `/v1/agents/${encodeURIComponent(input.agentId)}/messages/stream` : `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages`;
    let messages: unknown[] = [{ role: 'user', content: resourcePrompt(input.message, resources), otid: input.requestId }];
    await emit({ type: 'status', status: 'running' });
    try {
      for (;;) {
        const response = await this.request(path, { method: 'POST', body: JSON.stringify({ messages, stream_tokens: true, streaming: true }) }, {}, true);
        if (!response.body) { this.responses.get(response)?.finish(); throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned an empty stream.', 502); }
        let stopReason: string | undefined; let done = false; let approval: Approval | undefined; let providerRunId: string | undefined;
        const pendingCalls = new Map<string, { id: string; name: string; arguments: string }>();
        const toolFragments = new Map<string, { id: string; name: string; arguments: string }>();
        const transport = this.responses.get(response);
        try { for await (const data of parseSse(response.body, transport?.touch, transport?.controller.signal)) {
          if (data === '[DONE]') { done = true; continue; }
          let event: RecordValue;
          try { event = record(JSON.parse(data)); } catch { throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned an invalid streaming event.', 502); }
          if (str(event.run_id) && event.run_id !== providerRunId) { providerRunId = str(event.run_id); await emit({ type: 'status', status: 'running', providerRunId }); }
          const type = str(event.message_type) ?? str(event.type);
          if (type === 'assistant_message') { const text = contentText(event.content); if (text) await emit({ type: 'text', text, messageId: str(event.id) }); }
          if (type === 'tool_call_message' || type === 'approval_request_message') {
            const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [event.tool_call ?? event.tool_calls];
            for (const [index, raw] of calls.entries()) { const call = record(raw); if (!Object.keys(call).length) continue; const f = Object.keys(record(call.function)).length ? record(call.function) : call;
              const fragmentKey = `${type}:${str(event.id) ?? input.runId}:${index}`; const previous = toolFragments.get(fragmentKey);
              const toolCall = mergeToolCall(previous, { id: str(call.tool_call_id) ?? str(call.id) ?? previous?.id ?? str(event.id) ?? input.runId, name: str(f.name) ?? 'Tool', arguments: typeof f.arguments === 'string' ? f.arguments : f.arguments ? JSON.stringify(f.arguments) : '' });
              toolFragments.set(fragmentKey, toolCall);
              if (type === 'approval_request_message') pendingCalls.set(toolCall.id, toolCall); else await emit({ type: 'tool_call', toolCall });
            }
            if (type === 'approval_request_message') approval = { id: requiredId(event.id), toolName: [...pendingCalls.values()].map(call => call.name).join(', ') || 'Tool', arguments: JSON.stringify([...pendingCalls.values()]), description: pendingCalls.size > 1 ? 'This decision applies to all listed tool calls.' : undefined };
          }
          if (type === 'tool_return_message') await emit({ type: 'tool_result', toolCallId: str(event.tool_call_id) ?? '', content: contentText(event.tool_return), isError: event.status === 'error' });
          if (type === 'usage_statistics') addUsage(usage, event);
          if (type === 'stop_reason') stopReason = str(event.stop_reason);
          if (type === 'error' || event.error) { await emit({ type: 'error', message: 'Letta reported a run error. Review the server logs for details.' }); await emitUsage(); await emit({ type: 'status', status: 'failed', providerRunId }); return; }
        } } finally { transport?.finish(); }
        if (approval) {
          const decision = new Promise<boolean | 'cancel-requested'>(resolve => this.pending.set(input.runId, { id: approval!.id, resolve }));
          await emit({ type: 'approval', approval }); await emit({ type: 'status', status: 'waiting_for_approval', providerRunId });
          const approved = await decision; this.pending.delete(input.runId);
          if (this.shuttingDown) return;
          if (approved === 'cancel-requested') { await emit({ type: 'status', status: 'cancelling', providerRunId }); return; }
          messages = [{ type: 'approval', approval_request_id: approval.id, approve: approved, approvals: [...pendingCalls.values()].map(call => ({ tool_call_id: call.id, approve: approved, type: 'approval' })) }];
          await emit({ type: 'status', status: 'running' }); continue;
        }
        const status = stopReason === 'cancelled' ? 'cancelled' : stopReason && !['end_turn', 'no_tool_call', 'tool_rule'].includes(stopReason) ? (stopReason === 'requires_approval' ? 'interrupted' : 'failed') : done || stopReason ? 'completed' : 'interrupted';
        await emitUsage(); await emit({ type: 'status', status, providerRunId }); return;
      }
    } finally { this.pending.delete(input.runId); await emitUsage(); }
  }
  async cancel(run: Run) {
    if (this.caps.cancel.state !== 'supported') unsupported('Remote cancellation');
    // Restrict cancellation to an identified run, never cancel another client’s agent work.
    if (!run.providerRunId) throw new ProviderError('CONFLICT', 'Letta has not returned a run identifier yet. Reconcile the run before cancelling.', 409);
    await this.json(`/v1/agents/${encodeURIComponent(run.agentId)}/messages/cancel`, { method: 'POST', body: JSON.stringify({ run_ids: [run.providerRunId] }) });
    this.pending.get(run.id)?.resolve('cancel-requested');
  }
  async approve(run: Run, approvalId: string, approved: boolean) {
    const pending = this.pending.get(run.id);
    if (!pending || pending.id !== approvalId) throw new ProviderError('CONFLICT', 'This approval is no longer attached to an active connection. Reconcile and use the Letta interface to recover it.', 409);
    pending.resolve(approved);
  }
  async reconcile(run: Run) {
    if (!run.providerRunId) return null;
    const raw = record(await this.json(`/v1/runs/${encodeURIComponent(run.providerRunId)}`));
    const status = remoteStatus(raw.status, raw.stop_reason);
    if (status === 'completed') {
      const response = await this.json(`/v1/runs/${encodeURIComponent(run.providerRunId)}/messages`, undefined, { limit: 1000 });
      return { status, response: array(response).filter(m => record(m).message_type === 'assistant_message').map(m => contentText(record(m).content)).join('') };
    }
    return { status };
  }
  async listMemory(agentId: string, options?: ListOptions): Promise<Page<MemoryItem>> {
    const raw = await this.json(`/v1/agents/${encodeURIComponent(agentId)}/core-memory/blocks`);
    return filteredPage(array(raw).map(mapMemory), options);
  }
  async updateMemory(agentId: string, id: string, content: string) {
    // Resolve the label from the attached block; arbitrary global blocks cannot be written.
    const { items } = await this.listMemory(agentId, { limit: 200 }); const item = items.find(entry => entry.id === id);
    if (!item) throw new ProviderError('NOT_FOUND', 'This memory block is no longer attached to the agent.', 404);
    return mapMemory(await this.json(`/v1/agents/${encodeURIComponent(agentId)}/core-memory/blocks/${encodeURIComponent(item.title)}`, { method: 'PATCH', body: JSON.stringify({ value: content }) }));
  }
  async listFiles(agentId: string, options?: ListOptions) {
    return page(await this.json(`/v1/agents/${encodeURIComponent(agentId)}/files`, undefined, { limit: limitOf(options), after: options?.cursor }), mapFile, options);
  }
  async listRoutines(agentId: string) {
    const routines = []; let after: string | undefined;
    for (;;) {
      const response = record(await this.json(`/v1/agents/${encodeURIComponent(agentId)}/schedule`, undefined, { limit: 100, after })); const rows = array(response.scheduled_messages);
      routines.push(...rows.map(row => mapRoutine(row, agentId)));
      const next = str(record(rows.at(-1)).id); if (!response.has_next_page || !next || next === after) break; after = next;
    }
    return routines;
  }
  async createRoutine(input: CreateRoutineInput) {
    if (input.cron && !['UTC', 'Etc/UTC'].includes(input.timezone)) throw new ProviderError('VALIDATION', 'Legacy Letta recurring schedules use UTC. Choose UTC for the cron expression.', 400);
    const raw = record(await this.json(`/v1/agents/${encodeURIComponent(input.agentId)}/schedule`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: input.prompt }], schedule: input.cron ? { type: 'recurring', cron_expression: input.cron } : { type: 'one-time', scheduled_at: Math.floor(new Date(input.scheduledAt!).getTime() / 1000) } }) }));
    const id = requiredId(raw.id);
    return mapRoutine(await this.json(`/v1/agents/${encodeURIComponent(input.agentId)}/schedule/${encodeURIComponent(id)}`), input.agentId);
  }
  async deleteRoutine(agentId: string, id: string) { await this.json(`/v1/agents/${encodeURIComponent(agentId)}/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  async runRoutine() { unsupported('Running a legacy schedule immediately'); }
  async pauseRoutine() { unsupported('Pausing a legacy schedule'); }
  async listMachines() { return unsupported('Machine discovery'); }
  async close() { this.shuttingDown = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); for (const pending of this.pending.values()) pending.resolve(false); this.pending.clear(); }
}
