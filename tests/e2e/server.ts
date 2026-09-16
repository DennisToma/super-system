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
app.get('/api/test-fixture/stats', async () => fixture.stats());
await app.listen({ host: '127.0.0.1', port: 4173 });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
