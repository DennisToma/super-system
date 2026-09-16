// Deterministic fixtures used exclusively by the isolated browser test server.
// Production never imports this module or exposes its fixture control routes.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  capabilities, ProviderError, type AgentProvider, type Conversation,
  type MemoryItem, type Routine, type Run,
} from '../../packages/core/src/index.js';

export function createTestProvider() {
  let executions = 0;
  let agentConfig = { agentId: 'agent-memo', name: 'Memo', description: 'Your workspace agent', model: 'test/model', system: 'Be helpful.', version: '1', editableFields: ['name', 'description', 'model', 'system'] as ('name' | 'description' | 'model' | 'system')[] };
  const conversations: Conversation[] = [
    { id: 'conversation-welcome', agentId: 'agent-memo', title: 'A fresh start' },
  ];
  const memory: MemoryItem = {
    id: 'memory-profile', title: 'Working preferences', kind: 'core', editable: true,
    content: 'I prefer concise answers and clear next steps.', version: '1',
  };
  const routines: Routine[] = [];
  const pending = new Map<string, { resolve: (approved: boolean) => void; approvalId: string }>();
  const statuses = new Map<string, Run['status']>();
  const supported = capabilities('supported');
  supported.machines = { state: 'unsupported', reason: 'This server does not report machine status.' };
  supported.routineRun = { state: 'unsupported', reason: 'This server owns schedule execution.' };
  supported.routinePause = { state: 'unsupported', reason: 'This server does not support pausing schedules.' };
  const provider: AgentProvider = {
    async checkConnection() {
      return {
        configured: true, status: 'connected', mode: 'legacy', label: 'Isolated browser test provider',
        baseUrl: 'http://127.0.0.1:4173/test-provider', agentId: 'agent-memo', version: 'test-fixture',
        latencyMs: 1, checkedAt: new Date().toISOString(), capabilities: supported,
      };
    },
    async listAgents() { return [{ id: 'agent-memo', name: agentConfig.name, model: agentConfig.model }]; },
    async getAgentConfiguration() { return structuredClone(agentConfig); },
    async updateAgentConfiguration(_id, patch) { if (patch.expectedVersion !== agentConfig.version) throw new ProviderError('CONFLICT', 'Configuration changed.', 409); const { expectedVersion: _version, ...fields } = patch; agentConfig = { ...agentConfig, ...fields, version: String(Number(agentConfig.version) + 1) }; return structuredClone(agentConfig); },
    async getGatewayRuntime() { return { backend: 'test', version: 'test-fixture', capabilities: { agent_management: true, runtime_external_tools_update: true } }; },
    async listConversations() { return { items: structuredClone(conversations) }; },
    async createConversation(agentId, title) {
      const item = { id: randomUUID(), agentId, title: title || 'New conversation', createdAt: new Date().toISOString() };
      conversations.unshift(item); return item;
    },
    async listMessages() { return { items: [] }; },
    async execute(input, emit) {
      executions++;
      statuses.set(input.runId, 'running');
      const callId = `call-${input.runId}`;
      await emit({ type: 'tool_call', toolCall: { id: callId, name: 'save_note', arguments: '{"title":"Today’s priorities"}', status: 'running' } });
      await emit({ type: 'text', text: 'I can prepare the change. ' });
      const approvalId = `approval-${input.runId}`;
      const approval = new Promise<boolean>(resolve => pending.set(input.runId, { resolve, approvalId }));
      statuses.set(input.runId, 'waiting_for_approval');
      await emit({ type: 'approval', approval: { id: approvalId, toolName: 'save_note', arguments: '{"title":"Today’s priorities"}', description: 'Save this note to your workspace?' } });
      const approved = await approval;
      pending.delete(input.runId);
      await emit({ type: 'status', status: 'running' });
      await emit({ type: 'tool_result', toolCallId: callId, content: approved ? 'Note saved.' : 'Action denied.', isError: !approved });
      await delay(50);
      await emit({ type: 'text', text: approved ? 'Your note is saved.' : 'No note was saved.' });
      await emit({ type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, durationMs: 250 } });
      statuses.set(input.runId, 'completed');
      await emit({ type: 'status', status: 'completed' });
    },
    async approve(run, approvalId, approved) {
      const item = pending.get(run.id);
      if (!item || item.approvalId !== approvalId) throw new ProviderError('APPROVAL_EXPIRED', 'The test approval has expired.', 409);
      item.resolve(approved);
    },
    async cancel(run) { pending.get(run.id)?.resolve(false); },
    async reconcile(run) { const status = statuses.get(run.id); return status ? { status } : null; },
    async listMemory(_agentId, options) {
      return { items: !options?.query || `${memory.title} ${memory.content}`.toLowerCase().includes(options.query.toLowerCase()) ? [{ ...memory }] : [] };
    },
    async updateMemory(_agentId, _id, content) {
      memory.content = content; memory.version = String(Number(memory.version) + 1); return { ...memory };
    },
    async listFiles() {
      return { items: [
        { id: 'file-brief', name: 'Project brief.md', source: 'Workspace knowledge', size: 2048, openInContext: true, createdAt: '2026-09-16T08:00:00Z' },
        { id: 'file-notes', name: 'Research notes.pdf', source: 'Research', size: 123456, openInContext: false },
      ] };
    },
    async listRoutines() { return structuredClone(routines); },
    async createRoutine(input) {
      const routine: Routine = { ...input, id: randomUUID(), state: 'active', executionTarget: 'Hetzner test target' };
      routines.push(routine); return routine;
    },
    async deleteRoutine(_agentId, id) { const index = routines.findIndex(item => item.id === id); if (index >= 0) routines.splice(index, 1); },
    async runRoutine() { throw new ProviderError('UNSUPPORTED', supported.routineRun.reason!, 501); },
    async pauseRoutine() { throw new ProviderError('UNSUPPORTED', supported.routinePause.reason!, 501); },
    async listMachines() { throw new ProviderError('UNSUPPORTED', supported.machines.reason!, 501); },
    async close() { for (const item of pending.values()) item.resolve(false); },
  };
  return { provider, stats: () => ({ executions, pendingApprovals: pending.size }) };
}
