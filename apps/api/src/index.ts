import { createProvider } from '@super-system/provider-letta';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createFileStore, createPostgresStore } from './store.js';

async function main() {
  const config = readConfig();
  if (process.env.LETTA_MODE && !['legacy', 'app-server'].includes(process.env.LETTA_MODE)) throw new Error('LETTA_MODE must be legacy or app-server.');
  const provider = createProvider({ mode: process.env.LETTA_MODE === 'app-server' ? 'app-server' : 'legacy', baseUrl: process.env.LETTA_BASE_URL, apiKey: process.env.LETTA_API_KEY, agentId: process.env.LETTA_AGENT_ID, serverToken: process.env.LETTA_SERVER_TOKEN });
  const store = config.databaseUrl ? await createPostgresStore(config.databaseUrl, () => {
    console.error('Database ownership was lost. Stopping the API to prevent conflicting run coordinators.');
    process.exit(1);
  }) : await createFileStore(config.dataDir);
  const { app } = await buildApp(config, provider, store);
  await app.listen({ host: config.host, port: config.port });
  console.log(`Super System API listening on port ${config.port} (${config.environment}, ${store.kind} persistence).`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    clearTimeout(timeout);
  };
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
}
main().catch(error => { console.error(error instanceof Error && !process.env.LETTA_BASE_URL && !process.env.DATABASE_URL ? error.message : 'Application startup failed. Check configuration and service availability.'); process.exitCode = 1; });
