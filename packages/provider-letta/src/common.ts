import { createHash } from 'node:crypto';
import { ProviderError, capabilities, type Agent, type AgentFile, type AgentProvider, type Capabilities, type CapabilityKey, type Connection, type Conversation, type ListOptions, type MemoryItem, type Message, type Page, type ProviderMode, type Routine, type RunStatus } from '@super-system/core';

export interface ProviderOptions { mode: ProviderMode; baseUrl?: string; apiKey?: string; agentId?: string; serverToken?: string }
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
export const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  return array(value).map(item => str(record(item).text) ?? '').filter(Boolean).join('\n');
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export const limitOf = (options?: ListOptions) => Math.max(1, Math.min(options?.limit ?? 50, 200));
export function safeUrl(options: ProviderOptions): URL {
  let url: URL;
  try { url = new URL(options.baseUrl!); } catch { throw new ProviderError('INVALID_CONFIG', 'The configured Letta URL is invalid.', 503); }
  const protocols = options.mode === 'legacy' ? ['http:', 'https:'] : ['http:', 'https:', 'ws:', 'wss:'];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProviderError('INVALID_CONFIG', 'Use a Letta service URL without embedded credentials, query parameters, or a fragment.', 503);
  return url;
}
export function sanitizeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError('PROVIDER_UNAVAILABLE', 'Letta did not complete the request. Check the connection and reconcile any interrupted work before sending again.', 503);
}
export function requiredId(value: unknown): string {
  const id = str(value);
  if (!id) throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned an incomplete response.', 502);
  return id;
}
export function mapAgent(value: unknown): Agent {
  const a = record(value);
  return { id: requiredId(a.id), name: str(a.name) ?? requiredId(a.id), description: str(a.description), model: str(a.model) ?? str(record(a.llm_config).model), createdAt: str(a.created_at) };
}
export function mapConversation(value: unknown, agentId: string): Conversation {
  const c = record(value);
  return { id: requiredId(c.id), agentId: str(c.agent_id) ?? agentId, title: str(c.summary) || str(c.name) || str(c.description) || 'Untitled conversation', createdAt: str(c.created_at), updatedAt: str(c.last_message_at) ?? str(c.updated_at) };
}
export function mapMessage(value: unknown, conversationId: string): Message | null {
  const m = record(value); const kind = str(m.message_type) ?? str(m.role);
  // Private reasoning and hidden runtime bookkeeping are intentionally excluded.
  const roles: Record<string, Message['role']> = { user_message: 'user', assistant_message: 'assistant', tool_call_message: 'assistant', approval_request_message: 'assistant', tool_return_message: 'tool', system_message: 'system', user: 'user', assistant: 'assistant', tool: 'tool', system: 'system' };
  if (!kind || !roles[kind]) return null;
  const rawCalls = Array.isArray(m.tool_calls) ? m.tool_calls : m.tool_call ? [m.tool_call] : [];
  const toolCalls = rawCalls.map(raw => { const t = record(raw); const f = Object.keys(record(t.function)).length ? record(t.function) : t; return { id: str(t.tool_call_id) ?? str(t.id) ?? requiredId(m.id), name: str(f.name) ?? 'Tool', arguments: typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments ?? {}) }; });
  return { id: requiredId(m.id), conversationId, role: roles[kind], content: kind === 'tool_return_message' ? contentText(m.tool_return) : contentText(m.content), createdAt: str(m.date) ?? str(m.created_at), ...(toolCalls.length ? { toolCalls } : {}), toolCallId: str(m.tool_call_id) };
}
export function mapMemory(value: unknown): MemoryItem {
  const m = record(value); const content = contentText(m.value ?? m.content ?? m.text);
  return { id: requiredId(m.id), title: str(m.label) ?? str(m.title) ?? 'Memory', content, kind: 'core', editable: true, version: hash(content), description: str(m.description), updatedAt: str(m.updated_at) };
}
export function mapFile(value: unknown): AgentFile {
  const f = record(value);
  return { id: requiredId(f.file_id ?? f.id), name: str(f.file_name) ?? str(f.name) ?? 'File', source: str(f.folder_name) ?? str(f.source_name) ?? 'Letta attachment', size: typeof f.size === 'number' ? f.size : undefined, openInContext: typeof f.is_open === 'boolean' ? f.is_open : undefined, createdAt: str(f.created_at), path: str(f.path) };
}
export function mapRoutine(value: unknown, agentId: string): Routine {
  const r = record(value), schedule = record(r.schedule), payload = record(r.message);
  const prompt = str(r.prompt) ?? array(payload.messages).map(m => contentText(record(m).content)).join('\n');
  const scheduledAt = typeof schedule.scheduled_at === 'number' ? new Date(schedule.scheduled_at * 1000).toISOString() : str(r.scheduled_for);
  return { id: requiredId(r.id), agentId: str(r.agent_id) ?? agentId, name: str(r.name) ?? (prompt.slice(0, 70) || 'Scheduled message'), prompt, cron: str(schedule.cron_expression) ?? (r.recurring !== false ? str(r.cron) : undefined), scheduledAt, timezone: str(r.timezone) ?? 'UTC', state: r.status === 'paused' ? 'paused' : r.status && r.status !== 'active' ? 'unknown' : 'active', nextRunAt: str(r.next_scheduled_time) ?? str(r.next_scheduled_at), lastRunAt: str(r.last_run_at) ?? str(r.last_fired_at), executionTarget: str(r.execution_target) };
}
export function page<T>(raw: unknown, mapper: (value: unknown) => T, options?: ListOptions): Page<T> {
  const data = record(raw); const items = Array.isArray(raw) ? raw : array(data.items ?? data.messages ?? data.files ?? data.data);
  const next = str(data.next_cursor) ?? str(data.nextCursor) ?? str(data.next_before);
  const hasMore = data.has_more ?? data.has_next_page;
  const explicitEnd = data.next_cursor === null || data.nextCursor === null || data.next_before === null;
  return { items: items.map(mapper), ...((next || (!explicitEnd && hasMore !== false && items.length >= limitOf(options))) ? { nextCursor: next ?? str(record(items.at(-1)).id) } : {}) };
}
export function filteredPage<T extends { id: string }>(items: T[], options?: ListOptions): Page<T> {
  const query = options?.query?.toLowerCase();
  const filtered = query ? items.filter(item => JSON.stringify(item).toLowerCase().includes(query)) : items;
  const cursorIndex = options?.cursor ? filtered.findIndex(item => item.id === options.cursor) : -1;
  if (options?.cursor && cursorIndex < 0) throw new ProviderError('VALIDATION', 'This page cursor is no longer available. Refresh the list.', 400);
  const start = cursorIndex + 1; const results = filtered.slice(start, start + limitOf(options));
  return { items: results, ...(start + results.length < filtered.length ? { nextCursor: results.at(-1)!.id } : {}) };
}
export function remoteStatus(value: unknown, stopReason?: unknown): RunStatus {
  if (stopReason === 'requires_approval') return 'waiting_for_approval';
  if (stopReason === 'cancelled' || value === 'cancelled') return 'cancelled';
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'running' || value === 'created') return 'running';
  return 'interrupted';
}
export abstract class ProviderBase {
  protected caps: Capabilities = capabilities('unavailable', 'Check the Letta connection to discover support.');
  constructor(protected readonly options: ProviderOptions) {}
  protected support(keys: CapabilityKey[], state: 'supported' | 'unsupported' | 'unavailable', reason?: string) { for (const key of keys) this.caps[key] = { state, ...(reason ? { reason } : {}) }; }
  protected connection(status: Connection['status'], extra: Partial<Connection> = {}): Connection {
    return { configured: Boolean(this.options.baseUrl), status, mode: this.options.mode, label: this.options.mode === 'legacy' ? 'Letta REST server' : 'Letta App Server', baseUrl: this.options.baseUrl ? safeUrl(this.options).toString().replace(/\/$/, '') : undefined, agentId: this.options.agentId, checkedAt: new Date().toISOString(), capabilities: structuredClone(this.caps), ...extra };
  }
}
export function guarded(provider: AgentProvider): AgentProvider {
  return new Proxy(provider, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return async (...args: unknown[]) => { try { return await value.apply(target, args); } catch (error) { throw sanitizeError(error); } }; } });
}

/** A call event is an upsert; arguments can arrive as JSON fragments or a full snapshot. */
export function mergeToolCall(previous: { id: string; name: string; arguments: string } | undefined, next: { id: string; name: string; arguments: string }) {
  if (!previous) return next;
  let fullSnapshot = false; try { JSON.parse(next.arguments); fullSnapshot = true; } catch { /* Incomplete streamed arguments. */ }
  const name = !next.name || next.name === 'Tool' || next.name === '?' ? previous.name : next.name;
  return { id: previous.id, name, arguments: fullSnapshot ? next.arguments : previous.arguments + next.arguments };
}
