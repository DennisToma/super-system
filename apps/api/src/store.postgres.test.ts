import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createPostgresStore, emptyState, type Store } from './store.js';

// Opt in with a disposable PostgreSQL admin URL. Each run creates its own database.
const adminUrl = process.env.SUPER_SYSTEM_TEST_DATABASE_URL;
describe.skipIf(!adminUrl)('PostgreSQL persistence and ownership', () => {
  it('persists transactions, excludes other owners, and fences a disconnected owner', async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    const database = `super_system_test_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    const stores = new Set<Store>();
    let created = false;
    const openStore = async (onOwnershipLost?: () => void) => {
      const store = await createPostgresStore(url.href, onOwnershipLost);
      stores.add(store);
      return store;
    };
    const closeStore = async (store: Store) => { await store.close(); stores.delete(store); };
    try {
      await admin`create database ${admin(database)}`;
      created = true;
      let store = await openStore();
      expect(await store.read()).toEqual(emptyState());
      await expect(createPostgresStore(url.href)).rejects.toThrow('already owned');

      await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(state => {
        state.activity.push({ id: String(i), type: 'system', title: 'Persistence test', createdAt: new Date().toISOString() });
        state.preferences.theme = 'dark';
      })));
      const saved = await store.read();
      expect(saved.activity).toHaveLength(20);
      await expect(store.update(state => {
        state.preferences.theme = 'light';
        throw new Error('Rollback test');
      })).rejects.toThrow('Rollback test');
      expect(await store.read()).toEqual(saved);

      await closeStore(store);
      let lost = false;
      store = await openStore(() => { lost = true; });
      expect(await store.read()).toEqual(saved);
      const owners = await admin`
        select l.pid from pg_locks l join pg_database d on d.oid = l.database
        where l.locktype = 'advisory' and l.classid = 0 and l.objid = 782619401
          and l.objsubid = 1 and l.granted and d.datname = ${database}`;
      expect(owners).toHaveLength(1);
      await admin`select pg_terminate_backend(${owners[0]!.pid})`;
      await expect.poll(() => lost, { timeout: 5000 }).toBe(true);
      await expect(store.read()).rejects.toThrow('ownership was lost');
      await expect(store.update(state => { state.preferences.theme = 'light'; })).rejects.toThrow('ownership was lost');

      const replacement = await openStore();
      expect(await replacement.read()).toEqual(saved);
      await replacement.update(state => { state.preferences.timezone = 'Europe/Vienna'; });
      expect((await replacement.read()).preferences.timezone).toBe('Europe/Vienna');
    } finally {
      await Promise.allSettled([...stores].map(store => store.close()));
      try { if (created) await admin`drop database ${admin(database)} with (force)`; }
      finally { await admin.end(); }
    }
  });
});
