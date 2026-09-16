import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { Activity, MemoryRevision, Preferences, Run, RunEvent, WorkspaceSkill, McpServer, McpConnection, OfficeTask } from '@super-system/core';

/** Server-only persistence shape; credentials are projected out of every response. */
export type McpServerRecord = Omit<McpServer, 'hasCredentials'> & Pick<McpConnection, 'env' | 'headers'>;
export interface State {
  version: 1; runs: Run[]; events: RunEvent[]; activity: Activity[];
  revisions: MemoryRevision[]; preferences: Preferences;
  skills: WorkspaceSkill[]; mcpServers: McpServerRecord[]; tasks: OfficeTask[];
}
export const emptyState = (): State => ({ version: 1, runs: [], events: [], activity: [], revisions: [], skills: [], mcpServers: [], tasks: [], preferences: { theme: 'system', timezone: 'UTC' } });
export interface Store {
  kind: 'file' | 'postgres';
  read(): Promise<State>;
  update<T>(change: (state: State) => T): Promise<T>;
  close(): Promise<void>;
}
function parseState(value: unknown): State {
  const state = value as State;
  if (!state || state.version !== 1 || !Array.isArray(state.runs) || !Array.isArray(state.events) || !Array.isArray(state.activity) || !Array.isArray(state.revisions) || !state.preferences) throw new Error('Application state is invalid. Restore a backup before starting.');
  for (const key of ['skills', 'mcpServers', 'tasks'] as const) {
    if (state[key] === undefined) state[key] = [];
    else if (!Array.isArray(state[key])) throw new Error('Application management state is invalid. Restore a backup before starting.');
  }
  return state;
}

// One application process owns a store. Persist before publishing any event.
export async function createFileStore(dir: string): Promise<Store> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'state.json');
  const lockPath = join(dir, 'writer.lock');
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('The application data directory is already in use. Run only one API process.');
      await rm(lockPath, { force: true });
    }
  }
  if (!lock) throw new Error('Could not acquire the application data lock.');
  let state: State;
  try { state = parseState(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = emptyState();
    else { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  }
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  return {
    kind: 'file',
    async read() { await chain; return structuredClone(state); },
    update<T>(change: (state: State) => T): Promise<T> {
      if (closed) return Promise.reject(new Error('Store is closed.'));
      const next = chain.then(async () => {
        const draft = structuredClone(state);
        const result = change(draft);
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temp, 'wx', 0o600);
          try { await file.writeFile(JSON.stringify(draft)); await file.sync(); } finally { await file.close(); }
          await rename(temp, path);
          const directory = await open(dir, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } finally { await rm(temp, { force: true }); }
        state = draft;
        return structuredClone(result);
      });
      chain = next.catch(() => {});
      return next;
    },
    async close() { closed = true; await chain; await lock.close(); await rm(lockPath, { force: true }); },
  };
}

export async function createPostgresStore(url: string, onOwnershipLost?: () => void): Promise<Store> {
  let closed = false;
  let owned = false;
  let ownershipLost = false;
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const ownerClient = postgres(url, { max: 1, onnotice: () => {}, onclose: () => {
    if (owned && !closed) { ownershipLost = true; onOwnershipLost?.(); }
  } });
  const assertOwner = () => { if (closed || ownershipLost) throw new Error('Application database ownership was lost. Restart the API before continuing.'); };
  // A dedicated session lock prevents two coordinators from owning the same runs.
  const owner = await ownerClient.reserve();
  const [locked] = await owner`select pg_try_advisory_lock(782619401) as locked`;
  if (!locked?.locked) { owner.release(); await ownerClient.end(); await client.end(); throw new Error('This database is already owned by another API process.'); }
  owned = true;
  const db = drizzle(client);
  try {
    await db.execute(sql`create table if not exists workspace_state (id integer primary key check (id = 1), document jsonb not null)`);
    await db.execute(sql`insert into workspace_state (id, document) values (1, ${JSON.stringify(emptyState())}::jsonb) on conflict (id) do nothing`);
  } catch (error) { closed = true; await owner`select pg_advisory_unlock(782619401)`; owner.release(); await ownerClient.end(); await client.end(); throw error; }
  let chain: Promise<unknown> = Promise.resolve();
  return {
    kind: 'postgres',
    async read() { await chain; assertOwner(); const rows = await db.execute(sql`select document from workspace_state where id = 1`); assertOwner(); return structuredClone(parseState(rows[0]?.document)); },
    update<T>(change: (state: State) => T): Promise<T> {
      if (closed) return Promise.reject(new Error('Store is closed.'));
      const next = chain.then(() => db.transaction(async tx => {
        assertOwner();
        const rows = await tx.execute(sql`select document from workspace_state where id = 1 for update`);
        const draft = parseState(rows[0]?.document);
        const result = change(draft);
        assertOwner();
        await tx.execute(sql`update workspace_state set document = ${JSON.stringify(draft)}::jsonb where id = 1`);
        return structuredClone(result);
      }));
      chain = next.catch(() => {});
      return next;
    },
    async close() { await chain; closed = true; if (!ownershipLost) await owner`select pg_advisory_unlock(782619401)`; owner.release(); await ownerClient.end(); await client.end(); },
  };
}
