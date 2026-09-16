import { z } from 'zod';

export const APP_VERSION = '0.1.0';
export const capabilityKeys = ['chat', 'conversations', 'cancel', 'approvals', 'memoryRead', 'memoryWrite', 'files', 'routinesRead', 'routinesWrite', 'routineRun', 'routinePause', 'machines'] as const;
export type CapabilityKey = typeof capabilityKeys[number];
export type Capability = { state: 'supported' | 'unsupported' | 'unavailable'; reason?: string };
export type Capabilities = Record<CapabilityKey, Capability>;
export function capabilities(state: Capability['state'], reason?: string): Capabilities {
  return Object.fromEntries(capabilityKeys.map(key => [key, { state, ...(reason ? { reason } : {}) }])) as Capabilities;
}
export type ProviderMode = 'legacy' | 'app-server';
export interface Connection {
  configured: boolean;
  status: 'unconfigured' | 'connected' | 'error';
  mode: ProviderMode;
  label: string;
  baseUrl?: string;
  agentId?: string;
  version?: string;
  latencyMs?: number;
  checkedAt: string;
  error?: string;
  capabilities: Capabilities;
}
export interface Agent { id: string; name: string; description?: string; model?: string; createdAt?: string }
export interface Conversation { id: string; agentId: string; title: string; createdAt?: string; updatedAt?: string }
export interface ToolCall { id: string; name: string; arguments: string; status?: 'running' | 'completed' | 'failed' }
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export const runStatuses = ['queued', 'running', 'waiting_for_approval', 'completed', 'failed', 'interrupted', 'cancelling', 'cancelled'] as const;
export type RunStatus = typeof runStatuses[number];
export const terminalStatuses: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
export const isTerminal = (status: RunStatus) => terminalStatuses.includes(status);
export interface Approval { id: string; toolName: string; arguments: string; description?: string }
export type ProviderEvent =
  | { type: 'text'; text: string; messageId?: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'approval'; approval: Approval }
  | { type: 'status'; status: RunStatus; providerRunId?: string }
  | { type: 'error'; message: string };
export interface RunEvent { id: string; sequence: number; runId: string; createdAt: string; payload: ProviderEvent }
export interface Run {
  id: string;
  requestId: string;
  agentId: string;
  conversationId: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  providerRunId?: string;
  error?: string;
  approval?: Approval;
  response: string;
}
export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  kind: 'core' | 'archival' | 'file';
  editable: boolean;
  version: string;
  description?: string;
  scope?: string;
  updatedAt?: string;
}
export interface MemoryRevision {
  id: string;
  agentId: string;
  memoryId: string;
  title: string;
  before: string;
  after: string;
  createdAt: string;
}
export interface AgentFile { id: string; name: string; source: string; size?: number; openInContext?: boolean; createdAt?: string; path?: string }
export interface Routine {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  cron?: string;
  scheduledAt?: string;
  timezone: string;
  state: 'active' | 'paused' | 'unknown';
  nextRunAt?: string;
  lastRunAt?: string;
  executionTarget?: string;
}
export interface Machine { id: string; name: string; status: 'online' | 'offline' | 'unknown'; kind?: string; platform?: string; lastSeenAt?: string; version?: string }
export interface Activity {
  id: string;
  type: 'run' | 'memory' | 'routine' | 'system';
  title: string;
  description?: string;
  createdAt: string;
  status?: RunStatus;
  runId?: string;
  agentId?: string;
}
export interface Preferences { theme: 'light' | 'dark' | 'system'; selectedAgentId?: string; timezone: string }
export interface Overview {
  connection: Connection;
  agents: Agent[];
  recentRuns: Run[];
  activity: Activity[];
  counts: { conversations: number | null; memory: number | null; routines: number | null; files: number | null };
}
export interface SystemInfo {
  version: string;
  connection: Connection;
  persistence: 'file' | 'postgres';
  authRequired: boolean;
  environment: 'development' | 'production' | 'test';
  uptime: number;
  historyCoverage: string;
}
export interface ApiErrorBody { error: { code: string; message: string } }
export interface Page<T> { items: T[]; nextCursor?: string }
export interface ListOptions { cursor?: string; limit?: number; query?: string }
export interface StartRunInput { runId: string; requestId: string; agentId: string; conversationId: string; message: string }
export type EmitEvent = (event: ProviderEvent) => Promise<void>;
export interface CreateRoutineInput { agentId: string; name: string; prompt: string; cron?: string; scheduledAt?: string; timezone: string }
export interface AgentProvider {
  checkConnection(): Promise<Connection>;
  listAgents(): Promise<Agent[]>;
  listConversations(agentId: string, options?: ListOptions): Promise<Page<Conversation>>;
  createConversation(agentId: string, title?: string): Promise<Conversation>;
  listMessages(conversationId: string, agentId: string, options?: ListOptions): Promise<Page<Message>>;
  execute(input: StartRunInput, emit: EmitEvent): Promise<void>;
  cancel(run: Run): Promise<void>;
  approve(run: Run, approvalId: string, approved: boolean): Promise<void>;
  reconcile(run: Run): Promise<{ status: RunStatus; response?: string; approval?: Approval } | null>;
  listMemory(agentId: string, options?: ListOptions): Promise<Page<MemoryItem>>;
  updateMemory(agentId: string, id: string, content: string): Promise<MemoryItem>;
  listFiles(agentId: string, options?: ListOptions): Promise<Page<AgentFile>>;
  listRoutines(agentId: string): Promise<Routine[]>;
  createRoutine(input: CreateRoutineInput): Promise<Routine>;
  deleteRoutine(agentId: string, id: string): Promise<void>;
  runRoutine(agentId: string, id: string): Promise<void>;
  pauseRoutine(agentId: string, id: string, paused: boolean): Promise<void>;
  listMachines(): Promise<Machine[]>;
  close(): Promise<void>;
}
export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) { super(message); this.name = 'ProviderError'; }
}
export function unsupported(feature: string): never { throw new ProviderError('UNSUPPORTED', `${feature} is not supported by this Letta connection.`, 501); }

const id = z.string().trim().min(1).max(300);
export const sendMessageSchema = z.object({ requestId: z.string().uuid(), agentId: id, conversationId: id, message: z.string().trim().min(1).max(100_000) });
export const createConversationSchema = z.object({ agentId: id, title: z.string().trim().min(1).max(200).optional() });
export const memoryUpdateSchema = z.object({ content: z.string().max(200_000), expectedVersion: z.string().min(1).max(200) });
export const approvalSchema = z.object({ approvalId: id, approved: z.boolean() });
export const preferencesSchema = z.object({ theme: z.enum(['light', 'dark', 'system']), selectedAgentId: id.optional(), timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid timezone.') });
export const routineSchema = z.object({
  agentId: id,
  name: z.string().trim().min(1).max(150),
  prompt: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().max(200).optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  timezone: z.string().min(1).max(100),
}).refine(value => Boolean(value.cron) !== Boolean(value.scheduledAt), 'Choose either a recurring cron expression or a one-time date.');
