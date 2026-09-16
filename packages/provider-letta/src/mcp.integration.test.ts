import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { connectMcp, testMcpConnection } from './mcp.js';

describe('MCP wire integration', () => {
  it('uses the actual HTTP client for discovery and calls, with server credentials redacted', async () => {
    const methods: string[] = []; const authorizations: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(message.method); authorizations.push(request.headers.authorization ?? '');
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'lookup', description: 'Fixture', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: 'Echo Bearer fixture-secret' }], _meta: { token: 'fixture-secret' } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error();
    const config = { name: 'fixture', transport: 'http' as const, url: `http://127.0.0.1:${address.port}`, headers: { Authorization: 'Bearer fixture-secret' } };
    try {
      const discovery = await testMcpConnection(config);
      expect(discovery.tools).toEqual([{ name: 'lookup', description: 'Fixture' }]);
      expect(methods).not.toContain('tools/call');
      const client = await connectMcp(config);
      try { expect(await client.callTool('lookup', {})).toEqual({ content: [{ type: 'text', text: 'Echo [redacted]' }] }); }
      finally { await client.close(); }
      expect(methods.filter(method => method === 'tools/call')).toHaveLength(1);
      expect(authorizations.every(value => value === 'Bearer fixture-secret')).toBe(true);
    } finally { server.close(); await once(server, 'close'); }
  });
});

describe('MCP process ownership', () => {
  it('closes a real stdio server after discovery without executing tools', async () => {
    const script = `
      const readline = require('node:readline');
      const lines = readline.createInterface({ input: process.stdin });
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'lookup', description: String(process.pid), inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'Unexpected execution' }], isError: true };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
      });
    `;
    const result = await testMcpConnection({ name: 'local_fixture', transport: 'stdio', command: process.execPath, args: ['-e', script] });
    const pid = Number(result.tools[0]?.description);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
