import { z } from 'zod';
import type { Activity, Agent, Connection, Run } from './index.js';

const boundedId = z.string().trim().min(1).max(300);
const assignments = z.array(boundedId).max(100).default([]);
const version = z.string().min(1).max(100);
export const skillInputSchema = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).default(''),
  content: z.string().trim().min(1).max(50_000), agentIds: assignments, enabled: z.boolean().default(false),
}).strict();
export type SkillInput = z.infer<typeof skillInputSchema>;
export interface WorkspaceSkill extends SkillInput { id: string; version: string; updatedAt: string }
export const skillUpdateSchema = skillInputSchema.extend({ expectedVersion: version });

const credentials = z.record(z.string().min(1).max(100), z.string().max(8000)).refine(value => Object.keys(value).length <= 50, 'Use at most 50 credential fields.');
export const mcpInputSchema = z.object({
  name: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, 'Use a name beginning with a letter, followed by letters, numbers, dashes or underscores.'),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().trim().max(1000).optional(), args: z.array(z.string().max(2000)).max(50).default([]),
  url: z.string().max(2000).optional(), env: credentials.optional(), headers: credentials.optional(),
  clearCredentials: z.boolean().default(false), enabled: z.boolean().default(false), agentIds: assignments,
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (value.transport === 'stdio') {
    if (!value.command || /[\r\n\0]/.test(value.command)) issue('A stdio server needs an executable command. Arguments belong in the arguments field.');
    if (value.url || value.headers) issue('Stdio servers use a command and environment variables.');
  } else {
    try { const url = new URL(value.url || ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(); }
    catch { issue('Use an HTTP(S) URL without embedded credentials, query parameters, or a fragment. Put credentials in headers.'); }
    if (value.command || value.args.length || value.env) issue('HTTP and SSE servers use a URL and headers.');
  }
});
export type McpInput = z.infer<typeof mcpInputSchema>;
export const mcpUpdateSchema = mcpInputSchema.safeExtend({ expectedVersion: version });
export interface McpConnection {
  name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[];
  url?: string; env?: Record<string, string>; headers?: Record<string, string>;
}
export interface McpServer extends Omit<McpConnection, 'env' | 'headers'> {
  id: string; enabled: boolean; agentIds: string[]; hasCredentials: boolean; version: string; updatedAt: string;
}
/** Persisted server-only record. HTTP responses must project to McpServer. */
export interface McpServerRecord extends McpServer { env?: Record<string, string>; headers?: Record<string, string> }
export interface McpTestResult { status: 'connected'; checkedAt: string; latencyMs: number; tools: { name: string; description?: string }[] }
export interface RunResources { skills: { name: string; content: string }[]; mcpServers: McpConnection[] }
export interface UsageMeasurement { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; durationMs?: number }

export const agentConfigPatchSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(), description: z.string().max(2000).optional(),
  model: z.string().trim().min(1).max(300).optional(), system: z.string().max(100_000).optional(),
  expectedVersion: version,
}).strict().refine(value => ['name', 'description', 'model', 'system'].some(key => key in value), 'Choose a configuration field to update.');
export type AgentConfigPatch = z.infer<typeof agentConfigPatchSchema>;
export interface AgentConfiguration {
  agentId: string; name: string; description: string; model: string; system: string; version: string;
  editableFields: ('name' | 'description' | 'model' | 'system')[];
}
export interface GatewayRuntime { backend?: string; version?: string; capabilities: Record<string, boolean> }
export interface GatewayInfo {
  connection: Connection; runtime?: GatewayRuntime; runtimeError?: string; uptime: number;
  activeRuns: number; waitingRuns: number; interruptedRuns: number; mcpEnabled: number;
  transport: string; historyCoverage: string;
}
export const taskStatuses = ['backlog', 'in_progress', 'blocked', 'done'] as const;
export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(10_000).default(''),
  agentId: boundedId.optional(), status: z.enum(taskStatuses).default('backlog'), priority: z.enum(['low', 'normal', 'high']).default('normal'),
}).strict();
export type TaskInput = z.infer<typeof taskInputSchema>;
export interface OfficeTask extends TaskInput { id: string; version: string; createdAt: string; updatedAt: string }
export const taskUpdateSchema = taskInputSchema.extend({ expectedVersion: version });
export interface OfficeSnapshot { agents: Agent[]; tasks: OfficeTask[]; runs: Run[]; activity: Activity[]; connection: Connection }
export interface UsageTotals {
  runs: number; completed: number; failed: number; inputTokens: number | null; outputTokens: number | null;
  totalTokens: number | null; costUsd: number | null; durationMs: number | null;
  tokenMeasuredRuns: number; costMeasuredRuns: number; durationMeasuredRuns: number;
}
export interface UsageReport {
  days: number; timezone: 'UTC'; agentId?: string; from: string; to: string; totals: UsageTotals;
  daily: (UsageTotals & { date: string })[]; agents: (UsageTotals & { agentId: string; name: string })[];
  coverage: string;
}
