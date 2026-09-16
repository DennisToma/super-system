import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/api/src/app.js';
import { createFileStore } from '../../apps/api/src/store.js';
import { createTestProvider } from './provider.js';

const staticDir = resolve('apps/web/dist');
await access(join(staticDir, 'index.html')).catch(() => {
  throw new Error('Build the web application first: corepack pnpm --filter @super-system/web build');
});
const dataDir = await mkdtemp(join(tmpdir(), 'super-system-browser-test-'));
const fixture = createTestProvider();
const store = await createFileStore(dataDir);
const { app } = await buildApp({
  host: '127.0.0.1', port: 4173, origin: 'http://127.0.0.1:4173',
  password: 'browser-test-password', sessionSecret: 'isolated-browser-test-secret-'.repeat(3),
  secureCookie: false, environment: 'test', staticDir, dataDir,
}, fixture.provider, store);
app.addHook('onError', async (_request, reply, error) => {
  if (reply.statusCode >= 500) console.error('Isolated test server error:', error);
});
let mcpCalls = 0;
const mcpServer = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString());
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  if (message.method === 'tools/call') mcpCalls++;
  const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'browser-fixture', version: '1' } } : message.method === 'tools/list' ? { tools: [{ name: 'lookup_note', description: 'Find a fixture note.', inputSchema: { type: 'object' } }] } : { content: [] };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
mcpServer.listen(0, '127.0.0.1'); await once(mcpServer, 'listening');
const mcpAddress = mcpServer.address(); if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('MCP fixture failed to bind.');
app.get('/api/test-fixture/mcp', async () => ({ url: `http://127.0.0.1:${mcpAddress.port}`, calls: mcpCalls }));
app.get('/api/test-fixture/stats', async () => fixture.stats());
await app.listen({ host: '127.0.0.1', port: 4173 });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  mcpServer.close(); await once(mcpServer, 'close');
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
