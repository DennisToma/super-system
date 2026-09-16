import { randomUUID } from 'node:crypto';
import { createAppServerClient, type AppServerClient, type AppServerRawResponse } from '@letta-ai/letta-code/app-server-client';
import { LettaAgentClient, type AnyAgentTool, type CanUseToolResponse, type LettaCodeSession, type SDKMessage, type SDKProtocolMessage } from '@letta-ai/letta-agent-sdk/client';
import { ProviderError, measurement, unsupported, type AgentConfigPatch, type AgentProvider, type GatewayRuntime, type RunResources, type UsageMeasurement, type Approval, type CreateRoutineInput, type EmitEvent, type ListOptions, type Run, type RunStatus, type StartRunInput } from '@super-system/core';
import { array, contentText, filteredPage, hash, limitOf, mapAgent, mapConversation, mapMessage, mapRoutine, ProviderBase, record, mergeToolCall, requiredId, safeUrl, sanitizeError, str, type ProviderOptions, type RecordValue } from './common.js';

import { addUsage, configuration, configurationPatch, ConfigurationWrites, resourcePrompt } from './management.js';
import { connectMcp, redactMcpText, redactMcpEvent, type ConnectedMcp } from './mcp.js';

interface PendingDecision { approval: Approval; resolve: (decision: CanUseToolResponse) => void }
interface ActiveRun { session?: LettaCodeSession; controller: AbortController; connections: ConnectedMcp[]; status: RunStatus; cancelled: boolean; approval?: Approval; pending: PendingDecision[]; emit: EmitEvent }
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
  private readonly configurationWrites = new ConfigurationWrites();
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
  async getAgentConfiguration(agentId: string) {
    return configuration(await this.client.agents.retrieve(agentId));
  }
  async updateAgentConfiguration(agentId: string, patch: AgentConfigPatch) {
    return this.configurationWrites.run(agentId, async () => {
      const fields = configurationPatch(patch, await this.getAgentConfiguration(agentId));
      return configuration(await this.client.agents.update(agentId, fields));
    });
  }
  async getGatewayRuntime(): Promise<GatewayRuntime> {
    const info = await this.command(undefined, 'app_server_info');
    const raw = record(info.capabilities); const capabilities: Record<string, boolean> = {};
    for (const key of ['agent_management', 'conversation_management', 'memory_management', 'runtime_start', 'runtime_workspace_sandbox', 'runtime_external_tools_update', 'split_channels']) {
      if (typeof raw[key] === 'boolean') capabilities[key] = raw[key];
    }
    return { backend: str(info.backend), version: str(info.letta_code_version), capabilities };
  }
  async checkConnection() {
    const started = Date.now();
    try {
      const agents = await this.listAgents(); this.selectedAgent = this.options.agentId ?? agents[0]?.id;
      this.support(['chat', 'conversations', 'cancel', 'approvals'], 'supported');
      const info = await this.getGatewayRuntime(); const version = info.version; const caps = info.capabilities;
      this.support(['gateway'], 'supported');
      this.support(['agentConfigRead', 'agentConfigWrite'], caps.agent_management === true ? 'supported' : 'unsupported', caps.agent_management === true ? undefined : 'The remote runtime does not advertise agent management.');
      this.support(['mcp'], caps.runtime_external_tools_update === true ? 'supported' : 'unsupported', caps.runtime_external_tools_update === true ? undefined : 'The remote runtime does not advertise application-owned session tools.');
      if (this.selectedAgent) {
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
      this.support(['chat', 'conversations', 'cancel', 'approvals', 'memoryRead', 'memoryWrite', 'files', 'routinesRead', 'routinesWrite', 'routineRun', 'routinePause', 'agentConfigRead', 'agentConfigWrite', 'gateway', 'mcp'], 'unavailable', sanitizeError(error).message);
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
  private async requestApproval(context: ActiveRun, approval: Approval, signal?: AbortSignal): Promise<CanUseToolResponse> {
    const denied: CanUseToolResponse = { behavior: 'deny', message: 'The tool request was denied or cancelled.' };
    if (context.cancelled || signal?.aborted) return denied;
    let pending!: PendingDecision;
    const decision = new Promise<CanUseToolResponse>(resolve => { pending = { approval, resolve }; context.pending.push(pending); });
    const abort = () => pending.resolve(denied);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (context.pending.length === 1) {
        context.status = 'waiting_for_approval'; context.approval = approval;
        await context.emit({ type: 'approval', approval }); await context.emit({ type: 'status', status: 'waiting_for_approval' });
      }
      if (signal?.aborted) abort();
      return await decision;
    } finally {
      signal?.removeEventListener('abort', abort);
      const index = context.pending.indexOf(pending);
      if (index >= 0) {
        context.pending.splice(index, 1);
        if (index === 0 && !context.cancelled) {
          context.approval = context.pending[0]?.approval;
          context.status = context.approval ? 'waiting_for_approval' : 'running';
          if (context.approval) await context.emit({ type: 'approval', approval: context.approval });
          await context.emit({ type: 'status', status: context.status });
        }
      }
    }
  }
  async execute(input: StartRunInput, emit: EmitEvent, resources?: RunResources) {
    if (resources?.mcpServers.length && this.caps.mcp.state !== 'supported') unsupported('Application-owned MCP tools on this runtime');
    const output = emit;
    emit = event => output(redactMcpEvent(event, resources?.mcpServers ?? []));
    const context: ActiveRun = { controller: new AbortController(), connections: [], status: 'queued', cancelled: false, pending: [], emit };
    const tools: AnyAgentTool[] = []; const ownedNames = new Set<string>(); const usage: UsageMeasurement = {};
    let usageEmitted = false;
    const emitUsage = async () => {
      if (!usageEmitted && Object.keys(usage).length) { await emit({ type: 'usage', usage: { ...usage } }); usageEmitted = true; }
    };
    this.active.set(input.runId, context);
    try {
      for (const server of resources?.mcpServers ?? []) {
        if (context.cancelled) break;
        const connected = await connectMcp(server, context.controller.signal); context.connections.push(connected);
        for (const tool of connected.tools) {
          const name = `mcp_${server.name.slice(0, 24)}_${hash(`${server.name}:${tool.name}`).slice(0, 24)}`;
          if (ownedNames.has(name)) throw new ProviderError('VALIDATION', 'MCP tool names must be unique within a run.', 400);
          ownedNames.add(name);
          tools.push({ name, label: redactMcpText(`${server.name}: ${tool.name}`, resources?.mcpServers ?? []), description: tool.description ?? `Tool from ${server.name}`, parameters: tool.inputSchema,
            execute: async (_toolCallId, args, signal) => {
              const callSignal = signal ? AbortSignal.any([signal, context.controller.signal]) : context.controller.signal;
              const denied = { content: [{ type: 'text' as const, text: 'The operator denied or cancelled this MCP tool request.' }], isError: true };
              if (context.cancelled || callSignal.aborted) return denied;
              const decision = await this.requestApproval(context, { id: randomUUID(), toolName: `${server.name}: ${tool.name}`, arguments: redactMcpText(JSON.stringify(args), resources?.mcpServers ?? []), description: 'This external MCP tool requires your approval.' }, callSignal);
              // Enforce the decision at the actual side-effect boundary. SDK permission policy can bypass canUseTool.
              if (decision.behavior !== 'allow' || context.cancelled || callSignal.aborted) return denied;
              try { return await connected.callTool(tool.name, record(args), callSignal); }
              catch { return { content: [{ type: 'text' as const, text: 'The MCP server did not complete the tool request.' }], isError: true }; }
            },
          });
        }
      }
      if (context.cancelled) { context.status = 'cancelled'; await emit({ type: 'status', status: 'cancelled' }); return; }
      const session = this.client.resumeSession(input.conversationId, {
        permissionMode: 'standard', ...(tools.length ? { tools } : {}),
        canUseTool: async (toolName, args, detail) => {
          if (context.cancelled) return { behavior: 'deny', message: 'The operator requested cancellation.' };
          if (ownedNames.has(toolName)) return { behavior: 'allow' };
          return this.requestApproval(context, { id: detail?.requestId ?? detail?.toolCallId ?? randomUUID(), toolName, arguments: JSON.stringify(args), description: detail?.blockedPath ? `Requested access: ${detail.blockedPath}` : undefined }, context.controller.signal);
        },
      });
      context.session = session;
      const ready = await session.ready();
      const expectedConversation = input.conversationId === input.agentId ? 'default' : input.conversationId;
      if (ready.agentId !== input.agentId || ready.conversationId !== expectedConversation) throw new ProviderError('PROVIDER_REJECTED', 'The conversation does not belong to the selected agent.', 409);
      context.status = 'running'; await emit({ type: 'status', status: 'running' });
      if (context.cancelled) { context.status = 'cancelled'; await emit({ type: 'status', status: 'cancelled' }); return; }
      await session.send(resourcePrompt(input.message, resources), { otid: input.requestId });
      let terminal = false; let text = ''; let providerRunId: string | undefined; const cursors = new Map<string, number>(); const usageCursors = new Map<string, number>(); const usageIds = new Set<string>(); const streamedTools = new Map<string, { id: string; name: string; arguments: string }>();
      for await (const message of session.stream()) {
        if ('runId' in message && message.runId && providerRunId !== message.runId) { providerRunId = message.runId; await emit({ type: 'status', status: context.status, providerRunId }); }
        if ('seqId' in message && message.seqId !== undefined && message.runId) {
          if (message.seqId <= (cursors.get(message.runId) ?? -1)) continue; cursors.set(message.runId, message.seqId);
        }
        if (message.type === 'stream_event' && record(message.event).message_type === 'usage_statistics') {
          const raw = record(message.event); const runId = str(raw.run_id); const seq = measurement(raw.seq_id); const id = str(raw.id);
          const repeated = runId && seq !== undefined ? seq <= (usageCursors.get(runId) ?? -1) : id ? usageIds.has(id) : false;
          if (!repeated) {
            addUsage(usage, raw);
            if (runId && seq !== undefined) usageCursors.set(runId, seq);
            if (id) usageIds.add(id);
          }
        }
        const event = sdkEvent(message);
        if (event) {
          if (event.type === 'text') text += event.text;
          if (event.type === 'tool_call') { event.toolCall = { ...mergeToolCall(streamedTools.get(event.toolCall.id), event.toolCall), status: 'running' }; streamedTools.set(event.toolCall.id, event.toolCall); }
          await emit(event);
        }
        if (message.type === 'result') {
          // The result repeats the full text already emitted by the typed stream.
          if (!text && message.result) await emit({ type: 'text', text: message.result });
          const code = message.errorCode ?? message.error;
          context.status = message.success ? 'completed' : code === 'stream_closed' || code === 'protocol_error' ? 'interrupted' : context.cancelled && (code === 'interrupted' || message.stopReason === 'cancelled') ? 'cancelled' : code === 'interrupted' ? 'interrupted' : 'failed';
          const duration = measurement(message.durationMs), cost = measurement(message.totalCostUsd);
          if (duration !== undefined) usage.durationMs = duration;
          if (cost !== undefined) usage.costUsd = cost;
          await emitUsage();
          await emit({ type: 'status', status: context.status, providerRunId: message.runIds?.at(-1) ?? providerRunId }); terminal = true; break;
        }
      }
      if (!terminal) {
        await emitUsage();
        await emit({ type: 'status', status: 'interrupted', providerRunId });
      }
    } catch (error) {
      await emitUsage();
      if (context.cancelled && !context.session) { await emit({ type: 'status', status: 'cancelled' }); return; }
      throw error;
    } finally {
      this.active.delete(input.runId); context.cancelled = true; context.controller.abort(); context.session?.close();
      for (const pending of context.pending.splice(0)) pending.resolve({ behavior: 'deny', message: 'The session is no longer active.' });
      await Promise.allSettled(context.connections.map(connection => connection.close()));
    }
  }
  async cancel(run: Run) {
    const context = this.active.get(run.id);
    if (!context) throw new ProviderError('CONFLICT', 'This run is no longer attached to an active SDK session. Reconcile it and cancel from the Letta runtime if needed.', 409);
    context.cancelled = true;
    context.controller.abort();
    for (const pending of context.pending.splice(0)) pending.resolve({ behavior: 'deny', message: 'The operator requested cancellation.' });
    context.approval = undefined;
    await context.session?.abort();
  }
  async approve(run: Run, approvalId: string, approved: boolean) {
    const context = this.active.get(run.id);
    const pending = context?.pending[0];
    if (!context || context.cancelled || !pending || pending.approval.id !== approvalId) throw new ProviderError('CONFLICT', 'This approval is no longer attached to an active session. Recover it in the Letta runtime.', 409);
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
    await Promise.allSettled([...this.active.values()].map(async context => {
      context.cancelled = true; context.controller.abort(); context.session?.close();
      for (const pending of context.pending.splice(0)) pending.resolve({ behavior: 'deny', message: 'The connection closed.' });
      await Promise.allSettled(context.connections.map(connection => connection.close()));
    })); this.active.clear();
    if (this.management) {
      const entry = this.management; this.management = null;
      entry.detach(); entry.client.close();
    }
    await this.client.close();
  }
}
