import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isTerminal, ProviderError, type AgentProvider, type ProviderEvent, type Run, type RunEvent, type StartRunInput } from '@super-system/core';
import type { Store, State } from './store.js';

function append(state: State, run: Run, payload: ProviderEvent): RunEvent | null {
  if (isTerminal(run.status)) return null;
  const now = new Date().toISOString();
  const previous = run.status;
  if (payload.type === 'text') run.response += payload.text;
  if (payload.type === 'approval') { run.approval = payload.approval; run.status = 'waiting_for_approval'; }
  if (payload.type === 'error') run.error = payload.message;
  if (payload.type === 'status') {
    run.status = payload.status;
    if (payload.providerRunId) run.providerRunId = payload.providerRunId;
    if (!['waiting_for_approval', 'cancelling', 'interrupted'].includes(payload.status)) delete run.approval;
    if (isTerminal(payload.status)) run.completedAt = now;
  }
  run.updatedAt = now;
  const event: RunEvent = { id: randomUUID(), runId: run.id, sequence: (state.events.findLast(item => item.runId === run.id)?.sequence ?? 0) + 1, createdAt: now, payload };
  state.events.push(event);
  if (previous !== run.status) state.activity.unshift({ id: randomUUID(), type: 'run', title: `Run ${run.status.replaceAll('_', ' ')}`, description: run.prompt.slice(0, 180), createdAt: now, status: run.status, runId: run.id, agentId: run.agentId });
  return event;
}
export class RunCoordinator {
  private listeners = new EventEmitter();
  private jobs = new Map<string, Promise<void>>();
  private commands = new Set<string>();
  private closing = false;
  constructor(private store: Store, private provider: AgentProvider) { this.listeners.setMaxListeners(200); }
  async recover() {
    await this.store.update(state => {
      for (const run of state.runs) if (!isTerminal(run.status) && run.status !== 'interrupted') {
        append(state, run, { type: 'error', message: 'The application restarted while this run was unresolved. Reconcile with Letta before sending again.' });
        append(state, run, { type: 'status', status: 'interrupted' });
      }
    });
  }
  async get(id: string): Promise<Run> {
    const run = (await this.store.read()).runs.find(item => item.id === id);
    if (!run) throw new ProviderError('NOT_FOUND', 'Run not found.', 404);
    return run;
  }
  async emit(id: string, payload: ProviderEvent) {
    const event = await this.store.update(state => {
      const run = state.runs.find(item => item.id === id);
      if (!run) throw new Error('Missing run record.');
      return append(state, run, payload);
    });
    if (event) this.listeners.emit(id, event);
    return event;
  }
  subscribe(id: string, listener: (event: RunEvent) => void) {
    this.listeners.on(id, listener);
    return () => { this.listeners.off(id, listener); };
  }
  async events(id: string, after: number) { return (await this.store.read()).events.filter(item => item.runId === id && item.sequence > after); }
  async start(input: Omit<StartRunInput, 'runId'>): Promise<Run> {
    if (this.closing) throw new ProviderError('UNAVAILABLE', 'The application is shutting down.', 503);
    const { run, created } = await this.store.update(state => {
      const existing = state.runs.find(item => item.requestId === input.requestId);
      if (existing) {
        if (existing.agentId !== input.agentId || existing.conversationId !== input.conversationId || existing.prompt !== input.message) throw new ProviderError('REQUEST_CONFLICT', 'This request id was already used for a different message.', 409);
        return { run: existing, created: false };
      }
      if (state.runs.some(item => item.agentId === input.agentId && item.conversationId === input.conversationId && !isTerminal(item.status) && !item.releasedAt)) throw new ProviderError('RUN_UNRESOLVED', 'This conversation has unresolved work. Wait, cancel, or reconcile its run first.', 409);
      const now = new Date().toISOString();
      const run: Run = { id: randomUUID(), requestId: input.requestId, agentId: input.agentId, conversationId: input.conversationId, prompt: input.message, status: 'queued', createdAt: now, updatedAt: now, response: '' };
      state.runs.unshift(run);
      append(state, run, { type: 'status', status: 'queued' });
      return { run, created: true };
    });
    if (created) {
      const job = this.execute(run).finally(() => this.jobs.delete(run.id));
      this.jobs.set(run.id, job);
    }
    return run;
  }
  private async execute(run: Run) {
    try {
      await this.emit(run.id, { type: 'status', status: 'running' });
      await this.provider.execute({ runId: run.id, requestId: run.requestId, agentId: run.agentId, conversationId: run.conversationId, message: run.prompt }, async event => { await this.emit(run.id, event); });
      const current = await this.get(run.id);
      if (!isTerminal(current.status) && !['waiting_for_approval', 'interrupted', 'cancelling'].includes(current.status)) {
        await this.emit(run.id, { type: 'error', message: 'The provider stream ended without a confirmed result. Reconcile this run before sending again.' });
        await this.emit(run.id, { type: 'status', status: 'interrupted' });
      }
    } catch (error) {
      const rejected = error instanceof ProviderError && ['PROVIDER_REJECTED', 'VALIDATION', 'INVALID_CONFIG', 'UNSUPPORTED', 'UNCONFIGURED', 'NOT_FOUND'].includes(error.code);
      await this.emit(run.id, { type: 'error', message: rejected ? error.message : 'The connection ended before the result was confirmed. Check Letta and reconcile this run; your prompt was not automatically resent.' });
      await this.emit(run.id, { type: 'status', status: rejected ? 'failed' : 'interrupted' });
    }
  }
  private async command<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.commands.has(id)) throw new ProviderError('COMMAND_PENDING', 'A command for this run is already pending.', 409);
    this.commands.add(id);
    try { return await action(); } finally { this.commands.delete(id); }
  }
  async cancel(id: string) {
    return this.command(id, async () => {
      const { run, cancelling } = await this.store.update(state => {
        const current = state.runs.find(item => item.id === id);
        if (!current) throw new ProviderError('NOT_FOUND', 'Run not found.', 404);
        const run = structuredClone(current);
        return { run, cancelling: isTerminal(current.status) ? null : append(state, current, { type: 'status', status: 'cancelling' }) };
      });
      if (!cancelling) return run;
      this.listeners.emit(id, cancelling);
      try { await this.provider.cancel(run); }
      catch (error) {
        const rollback = await this.store.update(state => {
          const current = state.runs.find(item => item.id === id)!;
          if (!cancelling || state.events.findLast(item => item.runId === id)?.sequence !== cancelling.sequence) return null;
          return append(state, current, { type: 'status', status: run.status });
        });
        if (rollback) this.listeners.emit(id, rollback);
        throw error;
      }
      // Request acceptance is not confirmation that the provider stopped execution.
      return this.get(id);
    });
  }
  async approve(id: string, approvalId: string, approved: boolean) {
    return this.command(id, async () => {
      const run = await this.get(id);
      if (run.status !== 'waiting_for_approval' || run.approval?.id !== approvalId) throw new ProviderError('APPROVAL_EXPIRED', 'This approval is no longer pending. Refresh the run.', 409);
      await this.provider.approve(run, approvalId, approved);
      const current = await this.get(id);
      if (current.status === 'waiting_for_approval' && current.approval?.id === approvalId) await this.emit(id, { type: 'status', status: 'running' });
      return this.get(id);
    });
  }
  async reconcile(id: string) {
    return this.command(id, async () => {
      const snapshot = await this.store.read();
      const run = snapshot.runs.find(item => item.id === id);
      if (!run) throw new ProviderError('NOT_FOUND', 'Run not found.', 404);
      if (isTerminal(run.status)) return run;
      const sequence = snapshot.events.findLast(item => item.runId === id)?.sequence;
      const result = await this.provider.reconcile(run);
      if (!result) throw new ProviderError('OUTCOME_UNKNOWN', 'Letta could not confirm this run’s outcome. Inspect its conversation before taking further action.', 409);
      const events = await this.store.update(state => {
        const record = state.runs.find(item => item.id === id)!;
        if (isTerminal(record.status) || state.events.findLast(item => item.runId === id)?.sequence !== sequence) return [];
        if (result.response !== undefined) record.response = result.response;
        if (result.status !== 'interrupted' && result.status !== 'failed') delete record.error;
        const events: RunEvent[] = [];
        if (result.approval) { const event = append(state, record, { type: 'approval', approval: result.approval }); if (event) events.push(event); }
        const event = append(state, record, { type: 'status', status: result.status });
        if (event) events.push(event);
        return events;
      });
      for (const event of events) this.listeners.emit(id, event);
      return this.get(id);
    });
  }
  async release(id: string) {
    return this.command(id, async () => {
      if (this.jobs.has(id)) throw new ProviderError('RUN_ACTIVE', 'This run still has an active provider connection. Cancel or wait before releasing it.', 409);
      await this.store.update(state => {
        const run = state.runs.find(item => item.id === id);
        if (!run) throw new ProviderError('NOT_FOUND', 'Run not found.', 404);
        if (run.status !== 'interrupted') throw new ProviderError('RUN_NOT_INTERRUPTED', 'Only an interrupted run can be manually released.', 409);
        if (run.releasedAt) return;
        run.releasedAt = new Date().toISOString(); run.updatedAt = run.releasedAt;
        state.activity.unshift({ id: randomUUID(), type: 'run', title: 'Operator released an interrupted run', description: 'Remote outcome remains unconfirmed. No cancellation or resend was issued.', runId: id, agentId: run.agentId, status: run.status, createdAt: run.releasedAt });
      });
      await this.emit(id, { type: 'status', status: 'interrupted' });
      return this.get(id);
    });
  }
  async close() {
    this.closing = true;
    await this.provider.close();
    // Closing the application connection never issues a provider cancellation.
    await Promise.allSettled(this.jobs.values());
    await this.recover();
    this.listeners.emit('shutdown');
    this.listeners.removeAllListeners();
  }
}
