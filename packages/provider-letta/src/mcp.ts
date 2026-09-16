import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpInputSchema, ProviderError, type McpConnection, type McpTestResult, type ProviderEvent } from '@super-system/core';
import { record } from './common.js';

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const failure = () => new ProviderError('MCP_UNAVAILABLE', 'The MCP server did not complete the request. Check its configuration and connection.', 503);
export function redactMcpText(text: string, connections: McpConnection[]): string {
  const secrets = connections.flatMap(connection => [...Object.values(connection.env ?? {}), ...Object.values(connection.headers ?? {})]).flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}
async function bounded<T>(operation: Promise<T>, duration: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(failure());
      timer = setTimeout(abort, duration);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
/** Schema names, constraints and discriminants are executable structure; only prose is redacted. */
function redactMcpSchema<T>(value: T, connections: McpConnection[]): T {
  if (Array.isArray(value)) return value.map(item => redactMcpSchema(item, connections)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['description', 'title', '$comment'].includes(key) && typeof item === 'string' ? redactMcpText(item, connections) : redactMcpSchema(item, connections),
  ])) as T;
  return value;
}
/** Redact display content without changing routing, identity, lifecycle, or usage fields. */
export function redactMcpEvent(event: ProviderEvent, connections: McpConnection[]): ProviderEvent {
  const redact = (text: string) => redactMcpText(text, connections);
  switch (event.type) {
    case 'text': return { ...event, text: redact(event.text) };
    case 'tool_call': return { ...event, toolCall: { ...event.toolCall, name: redact(event.toolCall.name), arguments: redact(event.toolCall.arguments) } };
    case 'tool_result': return { ...event, content: redact(event.content) };
    case 'approval': return { ...event, approval: { ...event.approval, toolName: redact(event.approval.toolName), arguments: redact(event.approval.arguments), ...(event.approval.description !== undefined ? { description: redact(event.approval.description) } : {}) } };
    case 'error': return { ...event, message: redact(event.message) };
    case 'status': case 'usage': return event;
  }
}
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface ConnectedMcp {
  tools: McpTool[];
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}
/** Own transports before connecting so failed, timed-out and late handshakes are closable. */
export async function connectMcp(connection: McpConnection, signal?: AbortSignal): Promise<ConnectedMcp> {
  const { name, transport: kind, command, args, url, env, headers } = connection;
  if (!mcpInputSchema.safeParse({ name, transport: kind, command, args, url, env, headers }).success) throw new ProviderError('VALIDATION', 'Choose a valid MCP transport and connection configuration.', 400);
  if (signal?.aborted) throw failure();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const requestFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, combined]) : combined });
  let transport: Transport;
  if (connection.transport === 'stdio') transport = new StdioClientTransport({ command: connection.command!, args: connection.args ?? [], env: connection.env, stderr: 'ignore' });
  else {
    const options = { requestInit: { headers: connection.headers }, fetch: requestFetch };
    transport = connection.transport === 'http' ? new StreamableHTTPClientTransport(new URL(connection.url!), options) : new SSEClientTransport(new URL(connection.url!), options);
  }
  const client = new Client({ name: 'super-system', version: '0.1.0' });
  const dispose = async () => {
    controller.abort();
    await bounded(Promise.allSettled([client.close(), transport.close()]), CLOSE_TIMEOUT_MS).catch(() => {});
  };
  let closed = false; let closing: Promise<void> | undefined;
  const close = () => {
    closed = true; combined.removeEventListener('abort', abort);
    return closing ??= Promise.resolve().then(dispose);
  };
  const abort = () => { void close(); };
  combined.addEventListener('abort', abort, { once: true });
  const opening = (async () => {
    await client.connect(transport, { signal: combined, timeout: CONNECT_TIMEOUT_MS });
    const tools: McpTool[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do {
      if (closed || combined.aborted) throw failure();
      const page = await client.listTools(cursor ? { cursor } : {}, { signal: combined, timeout: CONNECT_TIMEOUT_MS });
      for (const tool of page.tools) {
        if (tools.length >= 100 || tool.name.length > 300 || JSON.stringify(tool.inputSchema).length > 100_000 || seen.has(tool.name)) throw failure();
        seen.add(tool.name);
        tools.push({ name: tool.name, description: tool.description ? redactMcpText(tool.description, [connection]).slice(0, 2000) : undefined, inputSchema: redactMcpSchema(tool.inputSchema, [connection]) });
      }
      if (page.nextCursor && (page.nextCursor === cursor || !page.tools.length)) throw failure();
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  })();
  // A non-cooperative connector can settle after the deadline; dispose its late state too.
  void opening.then(() => { if (closed) void dispose(); }, () => { if (closed) void dispose(); });
  try {
    const tools = await bounded(opening, CONNECT_TIMEOUT_MS, combined);
    return { tools, close: async () => { combined.removeEventListener('abort', abort); await close(); }, callTool: async (name, args, toolSignal) => {
      if (closed || combined.aborted || toolSignal?.aborted) throw failure();
      const callController = new AbortController();
      const callSignal = AbortSignal.any([combined, callController.signal, ...(toolSignal ? [toolSignal] : [])]);
      try {
        const result = await bounded(client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: CALL_TIMEOUT_MS }), CALL_TIMEOUT_MS, callSignal);
        // Only model-facing content leaves this layer, never response metadata or transport details.
        const content = Array.isArray(result.content) ? result.content.map(item => {
          const block = record(item);
          return { type: 'text' as const, text: redactMcpText(typeof block.text === 'string' ? block.text : JSON.stringify(block), [connection]) };
        }) : [];
        return { content, ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}) };
      } catch { throw failure(); } finally { callController.abort(); }
    } };
  } catch { await close(); throw failure(); }
}
/** Discovery lists tool metadata only; it never executes a tool. */
export async function testMcpConnection(connection: McpConnection): Promise<McpTestResult> {
  const start = Date.now(); const connected = await connectMcp(connection);
  try { return { status: 'connected', checkedAt: new Date().toISOString(), latencyMs: Date.now() - start, tools: connected.tools.map(({ name, description }) => ({ name: redactMcpText(name, [connection]), ...(description ? { description } : {}) })) }; }
  finally { await connected.close(); }
}
