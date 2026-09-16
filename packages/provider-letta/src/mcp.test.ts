import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ client: {} as any, transport: {} as any, transportOptions: undefined as any }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { constructor() { return mocks.client; } } }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { constructor(options: any) { mocks.transportOptions = options; return mocks.transport; } } }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class { constructor(_url: URL, options: any) { mocks.transportOptions = options; return mocks.transport; } } }));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class { constructor(_url: URL, options: any) { mocks.transportOptions = options; return mocks.transport; } } }));
import { connectMcp, testMcpConnection } from './mcp.js';
const connection = { name: 'fixture', transport: 'http' as const, url: 'https://tools.example.test/mcp', headers: { Authorization: 'Bearer credential-secret' } };
beforeEach(() => {
  mocks.client = { connect: vi.fn(async () => {}), listTools: vi.fn(async () => ({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }] })), close: vi.fn(async () => {}), callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Result Bearer credential-secret' }], _meta: { token: 'credential-secret' } })) };
  mocks.transport = { close: vi.fn(async () => {}) };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('bounded MCP transports', () => {
  it.each(['http', 'sse', 'stdio'] as const)('discovers %s tools without executing and closes', async transport => {
    const config = transport === 'stdio' ? { name: 'fixture', transport, command: 'node', env: { TOKEN: 'secret' } } : { ...connection, transport };
    const savedRecord = { ...config, id: 'saved-id', version: 'v1', hasCredentials: true };
    const result = await testMcpConnection(savedRecord);
    expect(result).toMatchObject({ status: 'connected', tools: [{ name: 'lookup', description: 'Lookup' }] });
    expect(mocks.client.callTool).not.toHaveBeenCalled();
    expect(mocks.client.close).toHaveBeenCalled(); expect(mocks.transport.close).toHaveBeenCalled();
    if (transport === 'stdio') expect(mocks.transportOptions.stderr).toBe('ignore');
  });
  it('collects all bounded discovery pages and projects/redacts content', async () => {
    mocks.client.listTools.mockResolvedValueOnce({ tools: [{ name: 'one', inputSchema: {} }], nextCursor: 'next' });
    const client = await connectMcp(connection);
    expect(client.tools.map(tool => tool.name)).toEqual(['one', 'lookup']);
    expect(mocks.client.listTools.mock.calls[1][0]).toEqual({ cursor: 'next' });
    expect(await client.callTool('lookup', {})).toEqual({ content: [{ type: 'text', text: 'Result [redacted]' }] });
    await client.close(); await client.close();
    expect(mocks.transport.close).toHaveBeenCalledTimes(1);
  });
  it('closes on initialization and discovery failure without exposing upstream details', async () => {
    mocks.client.connect.mockRejectedValueOnce(new Error('Bearer credential-secret'));
    await expect(testMcpConnection(connection)).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE', message: expect.not.stringContaining('credential-secret') });
    expect(mocks.transport.close).toHaveBeenCalled();
    mocks.client.listTools.mockRejectedValueOnce(new Error('Bearer credential-secret'));
    await expect(testMcpConnection(connection)).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
    expect(mocks.transport.close).toHaveBeenCalledTimes(2);
  });
  it('times out stalled initialization, then closes late completion too', async () => {
    vi.useFakeTimers(); let resolve!: () => void;
    mocks.client.connect.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const result = testMcpConnection(connection).catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ code: 'MCP_UNAVAILABLE' });
    expect(mocks.transport.close).toHaveBeenCalled();
    resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.client.listTools).not.toHaveBeenCalled();
    expect(mocks.transport.close.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('aborts pending tool calls and rejects cancelled calls before dispatch', async () => {
    const client = await connectMcp(connection); const controller = new AbortController();
    mocks.client.callTool.mockImplementation((_args: any, _schema: any, options: any) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret')))));
    const result = client.callTool('lookup', {}, controller.signal).catch(error => error);
    controller.abort(); expect(await result).toMatchObject({ code: 'MCP_UNAVAILABLE' });
    await expect(client.callTool('lookup', {}, controller.signal)).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
    expect(mocks.client.callTool).toHaveBeenCalledTimes(1); await client.close();
  });
  it('bounds call and cleanup time even when dependencies ignore cancellation', async () => {
    vi.useFakeTimers(); const client = await connectMcp(connection);
    mocks.client.callTool.mockImplementation(() => new Promise(() => {}));
    const result = client.callTool('lookup', {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(60_000); expect(await result).toMatchObject({ code: 'MCP_UNAVAILABLE' });
    mocks.client.close.mockImplementation(() => new Promise(() => {}));
    const closing = client.close(); await vi.advanceTimersByTimeAsync(5_000); await closing;
    expect(mocks.transport.close).toHaveBeenCalled();
  });
  it('preserves tool schema structure while redacting descriptive annotations', async () => {
    mocks.client.listTools.mockResolvedValue({ tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'running text 1' } }, required: ['text'] } }] });
    const client = await connectMcp({ name: 'fixture', transport: 'stdio', command: 'node', env: { MODE: 'running', TYPE: 'text', ONE: '1', OBJECT: 'object', STRING: 'string' } });
    expect(client.tools[0]?.inputSchema).toEqual({ type: 'object', properties: { text: { type: 'string', description: '[redacted] [redacted] [redacted]' } }, required: ['text'] });
    await client.close();
  });
  it('rejects invalid connection values before creating network traffic', async () => {
    await expect(testMcpConnection({ ...connection, url: 'https://user:secret@tools.test' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(mocks.client.connect).not.toHaveBeenCalled();
  });
});
