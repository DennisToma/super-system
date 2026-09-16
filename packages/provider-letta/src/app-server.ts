import { randomUUID } from 'node:crypto';
import { createAppServerClient, type AppServerClient, type AppServerRawResponse } from '@letta-ai/letta-code/app-server-client';
import { LettaAgentClient, type CanUseToolResponse, type LettaCodeSession, type SDKMessage, type SDKProtocolMessage } from '@letta-ai/letta-agent-sdk/client';
import { ProviderError, unsupported, type AgentProvider, type Approval, type CreateRoutineInput, type EmitEvent, type ListOptions, type Run, type RunStatus, type StartRunInput } from '@super-system/core';
import { array, contentText, filteredPage, hash, limitOf, mapAgent, mapConversation, mapMessage, mapRoutine, ProviderBase, record, mergeToolCall, requiredId, safeUrl, sanitizeError, str, type ProviderOptions, type RecordValue } from './common.js';

interface PendingDecision { approval: Approval; resolve: (decision: CanUseToolResponse) => void }
interface ActiveRun { session: LettaCodeSession; status: RunStatus; cancelled: boolean; approval?: Approval; pending: PendingDecision[]; emit: EmitEvent }
export function sdkEvent(message: SDKMessage) {
  switch (message.type) {
    case 'assistant': return { type: 'text' as const, text: message.content, messageId: message.uuid };
    case 'tool_call': return { type: 'tool_call' as const, toolCall: { id: message.toolCallId, name: message.toolName, arguments: message.rawArguments ?? JSON.stringify(message.toolInput), status: 'running' as const } };
    case 'tool_result': return { type: 'tool_result' as const, toolCallId: message.toolCallId, content: message.content, isError: message.isError };
    case 'error': return { type: 'error' as const, message: 'Letta reported a run error. Review the server logs for details.' };
    default: return null;
  }
}
export class AppServerProvider extends ProviderBase implements AgentProvider {
  private readonly client: LettaAgentClient;
  private readonly active = new Map<string, ActiveRun>();
  private management: { client: AppServerClient; ready: Promise<AppServerClient>; detach: () => void } | null = null;
  private readonly remoteOptions: { url: string; authToken?: string; requestTimeoutMs: number };
  private closed = false;
  private selectedAgent?: string;
  constructor(options: ProviderOptions) {
    super(options);
    const url = safeUrl(options); url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    this.remoteOptions = { url: url.toString(), authToken: options.serverToken || options.apiKey, requestTimeoutMs: 15_000 };
    this.client = new LettaAgentClient({ backend: 'remote', ...this.remoteOptions });
    this.support(['machines'], 'unsupported', 'Remote App Server management does not expose machine discovery. Device inspection requires attaching to a conversation runtime.');
    this.selectedAgent = options.agentId;
  }
  private managementConnection() {
    if (this.closed) throw new ProviderError('PROVIDER_UNAVAILABLE', 'The Letta connection is closed.', 503);
    if (this.management) return this.management.ready;
    // Management commands must never resume a session: SDK session initialization
    // installs approval handlers that can interfere with another client's turn.
    const client = createAppServerClient(this.remoteOptions);
    const entry = { client, ready: Promise.resolve(client), detach: () => {} };
    this.management = entry;
    entry.detach = client.onDisconnect(() => {
      if (this.management === entry) this.management = null;
      entry.detach(); client.close();
    });
    entry.ready = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new ProviderError('PROVIDER_UNAVAILABLE', 'The Letta management connection timed out.', 503)), 15_000); }),
        ]);
        return client;
      } catch (error) {
        if (this.management === entry) this.management = null;
        entry.detach(); client.close(); throw sanitizeError(error);
      } finally { clearTimeout(timeout); }
    })();
    return entry.ready;
  }
  private async command(_agentId: string | undefined, type: string, body: RecordValue = {}, predicate?: (message: SDKProtocolMessage) => boolean) {
    const client = await this.managementConnection();
    const requestId = randomUUID();
    try {
      const response = await client.requestRaw({ type, ...body, request_id: requestId }, {
        timeoutMs: 15_000,
        predicate: (message: unknown): message is AppServerRawResponse => {
          const frame = record(message);
          if (frame.type !== `${type}_response` || frame.request_id !== requestId) return false;
          return predicate ? predicate(frame as SDKProtocolMessage) : true;
        },
      });
      if (response.success === false) throw new ProviderError('PROVIDER_REJECTED', 'Letta could not perform this operation. The resource or capability may not be available on this runtime.', 502);
      return response;
    } catch (error) {
      if (!(error instanceof ProviderError) && this.management?.client === client) {
        this.management.detach(); this.management = null; client.close();
      }
      throw sanitizeError(error);
    }
  }
  async checkConnection() {
    const started = Date.now();
    try {
      const agents = await this.listAgents(); this.selectedAgent = this.options.agentId ?? agents[0]?.id;
      this.support(['chat', 'conversations', 'cancel', 'approvals'], 'supported');
      let version: string | undefined;
      if (this.selectedAgent) {
        const info = await this.command(this.selectedAgent, 'app_server_info'); version = str(info.letta_code_version);
        const caps = record(info.capabilities);
        if (caps.conversation_management === false) this.support(['conversations'], 'unsupported', 'The remote runtime does not support conversation management.');
        this.support(['memoryRead', 'memoryWrite', 'files'], caps.memory_management === true ? 'supported' : 'unsupported', caps.memory_management === true ? undefined : 'The remote runtime does not expose MemFS management.');
        // MemFS enablement belongs to the selected agent, not the whole runtime.
        // Individual resource requests report a disabled agent without hiding other agents’ memory.
        try {
          await this.listRoutines(this.selectedAgent); this.support(['routinesRead'], 'supported');
          const parts = (version ?? '').split('.').map(Number);
          const verifiedControls = parts.length >= 3 && (parts[0]! > 0 || parts[1]! > 32 || (parts[1] === 32 && parts[2]! >= 11));
          this.support(['routinesWrite', 'routineRun', 'routinePause'], verifiedControls ? 'supported' : 'unavailable', verifiedControls ? undefined : 'Schedule timezone and controls require a verified App Server version (0.32.11 or newer).');
        }
        catch (error) { this.support(['routinesRead', 'routinesWrite', 'routineRun', 'routinePause'], 'unavailable', 'Scheduling commands could not be verified on this App Server version.'); }
      } else this.support(['memoryRead', 'memoryWrite', 'files', 'routinesRead', 'routinesWrite', 'routineRun', 'routinePause'], 'unavailable', 'Select an existing agent to inspect runtime capabilities.');
      return this.connection('connected', { version, latencyMs: Date.now() - started });
    } catch (error) {
      this.support(['chat', 'conversations', 'cancel', 'approvals', 'memoryRead', 'memoryWrite', 'files', 'routinesRead', 'routinesWrite', 'routineRun', 'routinePause'], 'unavailable', sanitizeError(error).message);
      return this.connection('error', { error: sanitizeError(error).message, latencyMs: Date.now() - started });
    }
  }
  async listAgents() {
    if (this.options.agentId) return [mapAgent(await this.client.agents.retrieve(this.options.agentId))];
    const agents = []; let after: string | undefined; const seen = new Set<string>();
    for (;;) {
      const rows = await this.client.agents.list({ limit: 100, after });
      for (const row of rows) { const a = mapAgent(row); if (!seen.has(a.id)) { agents.push(a); seen.add(a.id); } }
      const next = rows.at(-1)?.id; if (rows.length < 100 || !next || next === after) break; after = next;
    }
    return agents;
  }
  async listConversations(agentId: string, options?: ListOptions) {
    const rows = await this.client.conversations.list({ agentId, after: options?.cursor, limit: limitOf(options), order: 'desc' });
    const items = rows.map(row => mapConversation(row, agentId));
    // Local CLI history belongs to an existing default conversation that is
    // omitted by conversation_list. Pin it on the first page; named pagination
    // remains keyed to the upstream rows. Agent IDs keep defaults isolated.
    if (!options?.cursor && (await this.command(agentId, 'app_server_info')).backend === 'local') {
      await this.client.agents.retrieve(agentId);
      items.unshift({ id: agentId, agentId, title: 'Default conversation' });
    }
    return { items, ...(rows.length >= limitOf(options) ? { nextCursor: rows.at(-1)?.id } : {}) };
  }
  async createConversation(agentId: string, title?: string) { return mapConversation(await this.client.conversations.create({ agentId, summary: title }), agentId); }
  private messagePage(conversationId: string, agentId: string, options?: ListOptions) {
    const isDefault = conversationId === agentId;
    // SDK 0.8.9 drops pagination metadata and has no agent scope for default
    // history. Use the read-only protocol directly, without resuming a session.
    return this.command(agentId, 'conversation_messages_list', {
      conversation_id: isDefault ? 'default' : conversationId,
      query: { ...(isDefault ? { agent_id: agentId } : {}), before: options?.cursor, limit: limitOf(options), order: 'desc' },
    });
  }
  async listMessages(conversationId: string, agentId: string, options?: ListOptions) {
    const response = await this.messagePage(conversationId, agentId, options);
    const messages = array(response.messages);
    const items = messages.map(row => mapMessage(row, conversationId)).filter(row => row !== null).reverse();
    const next = response.has_more === false ? undefined : str(response.next_before) ?? (messages.length >= limitOf(options) ? str(record(messages.at(-1)).id) : undefined);
    return { items, ...(next ? { nextCursor: next } : {}) };
  }
  async execute(input: StartRunInput, emit: EmitEvent) {
    let context: ActiveRun;
    const session = this.client.resumeSession(input.conversationId, {
      permissionMode: 'standard',
      canUseTool: async (toolName, args, detail) => {
        const approval: Approval = { id: detail?.requestId ?? detail?.toolCallId ?? randomUUID(), toolName, arguments: JSON.stringify(args), description: detail?.blockedPath ? `Requested access: ${detail.blockedPath}` : undefined };
        if (context.cancelled) return { behavior: 'deny', message: 'The operator requested cancellation.' };
        const decision = new Promise<CanUseToolResponse>(resolve => { context.pending.push({ approval, resolve }); });
        if (context.pending.length === 1) {
          context.status = 'waiting_for_approval'; context.approval = approval;
          await emit({ type: 'approval', approval }); await emit({ type: 'status', status: 'waiting_for_approval' });
        }
        return decision;
      },
    });
    context = { session, status: 'queued', cancelled: false, pending: [], emit }; this.active.set(input.runId, context);
    try {
      const ready = await session.ready();
      const expectedConversation = input.conversationId === input.agentId ? 'default' : input.conversationId;
      if (ready.agentId !== input.agentId || ready.conversationId !== expectedConversation) throw new ProviderError('PROVIDER_REJECTED', 'The conversation does not belong to the selected agent.', 409);
      context.status = 'running'; await emit({ type: 'status', status: 'running' });
      // SDK abort is a no-op before ready(). Retain cancellation intent so an
      // early Stop cannot dispatch the prompt once initialization finishes.
      if (context.cancelled) { context.status = 'cancelled'; await emit({ type: 'status', status: 'cancelled' }); return; }
      await session.send(input.message, { otid: input.requestId });
      let terminal = false; let text = ''; let providerRunId: string | undefined; const cursors = new Map<string, number>(); const tools = new Map<string, { id: string; name: string; arguments: string }>();
      for await (const message of session.stream()) {
        if ('runId' in message && message.runId && providerRunId !== message.runId) { providerRunId = message.runId; await emit({ type: 'status', status: context.status, providerRunId }); }
        if ('seqId' in message && message.seqId !== undefined && message.runId) {
          if (message.seqId <= (cursors.get(message.runId) ?? -1)) continue; cursors.set(message.runId, message.seqId);
        }
        const event = sdkEvent(message);
        if (event) {
          if (event.type === 'text') text += event.text;
          if (event.type === 'tool_call') { event.toolCall = { ...mergeToolCall(tools.get(event.toolCall.id), event.toolCall), status: 'running' }; tools.set(event.toolCall.id, event.toolCall); }
          await emit(event);
        }
        if (message.type === 'result') {
          // The result repeats the full text already emitted by the typed stream.
          if (!text && message.result) await emit({ type: 'text', text: message.result });
          const code = message.errorCode ?? message.error;
          context.status = message.success ? 'completed' : code === 'stream_closed' || code === 'protocol_error' ? 'interrupted' : context.cancelled && (code === 'interrupted' || message.stopReason === 'cancelled') ? 'cancelled' : code === 'interrupted' ? 'interrupted' : 'failed';
          await emit({ type: 'status', status: context.status, providerRunId: message.runIds?.at(-1) ?? providerRunId }); terminal = true; break;
        }
      }
      if (!terminal) await emit({ type: 'status', status: 'interrupted', providerRunId });
    } finally {
      this.active.delete(input.runId); session.close();
      for (const pending of context.pending.splice(0)) pending.resolve({ behavior: 'deny', message: 'The session is no longer active.' });
    }
  }
  async cancel(run: Run) {
    const context = this.active.get(run.id);
    if (!context) throw new ProviderError('CONFLICT', 'This run is no longer attached to an active SDK session. Reconcile it and cancel from the Letta runtime if needed.', 409);
    context.cancelled = true;
    try { await context.session.abort(); } catch (error) { context.cancelled = false; throw error; }
  }
  async approve(run: Run, approvalId: string, approved: boolean) {
    const context = this.active.get(run.id);
    const pending = context?.pending[0];
    if (!context || !pending || pending.approval.id !== approvalId) throw new ProviderError('CONFLICT', 'This approval is no longer attached to an active session. Recover it in the Letta runtime.', 409);
    context.pending.shift(); context.approval = context.pending[0]?.approval;
    context.status = context.approval ? 'waiting_for_approval' : 'running';
    if (context.approval) await context.emit({ type: 'approval', approval: context.approval });
    await context.emit({ type: 'status', status: context.status });
    pending.resolve(approved ? { behavior: 'allow' } : { behavior: 'deny', message: 'The operator denied this tool request.' });
  }
  async reconcile(run: Run) {
    const active = this.active.get(run.id);
    if (active) return { status: active.status, approval: active.approval };
    // The App Server exposes conversation history, but not a definitive per-run
    // outcome after this SDK process dies. Never infer completion from idle state.
    const rows = await this.messagePage(run.conversationId, run.agentId, { limit: 200 });
    const related = array(rows.messages).filter(message => record(message).run_id === run.providerRunId && Boolean(run.providerRunId));
    if (!related.length) return null;
    return { status: 'interrupted' as const, response: related.reverse().filter(message => record(message).message_type === 'assistant_message').map(message => contentText(record(message).content)).join('') };
  }
  private async memoryEntries(agentId: string) {
    const entries: unknown[] = [];
    const response = await this.command(agentId, 'list_memory', { agent_id: agentId }, message => {
      if (message.type !== 'list_memory_response') return false;
      entries.push(...array(message.entries)); return message.done === true || message.success === false;
    });
    if (response.memfs_enabled === false) throw new ProviderError('UNSUPPORTED', 'MemFS is not enabled for this existing agent.', 501);
    return entries.map(record);
  }
  async listMemory(agentId: string, options?: ListOptions) {
    const entries = await this.memoryEntries(agentId);
    return filteredPage(entries.filter(entry => entry.kind !== 'image').map(entry => {
      const content = str(entry.content) ?? ''; const path = requiredId(entry.relative_path);
      return { id: path, title: path, content, kind: 'file' as const, editable: true, version: hash(content), description: str(entry.description), scope: entry.is_system ? 'System memory' : 'Agent memory' };
    }), options);
  }
  async updateMemory(agentId: string, id: string, content: string) {
    if (id.startsWith('/') || id.split(/[\\/]/).includes('..') || id.includes('\0')) throw new ProviderError('VALIDATION', 'Choose a path within the agent memory directory.', 400);
    const entries = await this.memoryEntries(agentId); const item = entries.find(entry => entry.relative_path === id);
    if (!item || item.kind === 'image') throw new ProviderError('NOT_FOUND', 'This editable memory file is no longer available.', 404);
    await this.command(agentId, 'write_memory_file', { agent_id: agentId, path: id, content, encoding: 'utf8', commit_message: 'Update memory from Super System' });
    const readback = await this.command(agentId, 'read_memory_file', { agent_id: agentId, path: id, encoding: 'utf8' });
    if (typeof readback.content !== 'string') throw new ProviderError('PROVIDER_PROTOCOL', 'Letta saved the file but did not return readable content. Refresh memory before editing again.', 502);
    return { id, title: id, content: readback.content, kind: 'file' as const, editable: true, version: hash(readback.content), description: str(item.description), scope: item.is_system ? 'System memory' : 'Agent memory' };
  }
  async listFiles(agentId: string, options?: ListOptions) {
    const entries = await this.memoryEntries(agentId);
    return filteredPage(entries.map(entry => ({ id: requiredId(entry.relative_path), name: requiredId(entry.relative_path), source: 'Agent MemFS', path: requiredId(entry.relative_path), size: typeof entry.size === 'number' ? entry.size : undefined, openInContext: typeof entry.is_system === 'boolean' ? entry.is_system : undefined })), options);
  }
  async listRoutines(agentId: string) { const response = await this.command(agentId, 'cron_list', { agent_id: agentId }); return array(response.tasks).map(task => ({ ...mapRoutine(task, agentId), executionTarget: safeUrl(this.options).hostname })); }
  async createRoutine(input: CreateRoutineInput) {
    if (this.caps.routinesWrite.state !== 'supported') unsupported('Creating schedules with a verified timezone on this App Server version');
    const response = await this.command(input.agentId, 'cron_add', { agent_id: input.agentId, name: input.name, description: input.name, prompt: input.prompt, cron: input.cron ?? '* * * * *', timezone: input.timezone, recurring: Boolean(input.cron), scheduled_for: input.scheduledAt ?? null });
    return { ...mapRoutine(response.task, input.agentId), executionTarget: safeUrl(this.options).hostname };
  }
  private async routineCommand(agentId: string, id: string, type: string) {
    if (!(await this.listRoutines(agentId)).some(item => item.id === id)) throw new ProviderError('NOT_FOUND', 'This routine does not belong to the selected agent.', 404);
    const response = await this.command(agentId, type, { task_id: id });
    if (response.found === false) throw new ProviderError('NOT_FOUND', 'The routine no longer exists.', 404);
  }
  async deleteRoutine(agentId: string, id: string) { await this.routineCommand(agentId, id, 'cron_delete'); }
  async runRoutine(agentId: string, id: string) { if (this.caps.routineRun.state !== 'supported') unsupported('Running a routine immediately on this App Server version'); await this.routineCommand(agentId, id, 'cron_trigger'); }
  async pauseRoutine(agentId: string, id: string, paused: boolean) { if (this.caps.routinePause.state !== 'supported') unsupported('Pausing a routine on this App Server version'); await this.routineCommand(agentId, id, paused ? 'cron_pause' : 'cron_resume'); }
  async listMachines() {
    return unsupported('Machine discovery without attaching to a conversation runtime');
  }
  async close() {
    this.closed = true;
    for (const context of this.active.values()) context.session.close(); this.active.clear();
    if (this.management) {
      const entry = this.management; this.management = null;
      entry.detach(); entry.client.close();
    }
    await this.client.close();
  }
}
