import { describe, expect, it, vi } from 'vitest';
import { ConfigurationWrites, configuration, configurationPatch } from './management.js';

describe('configuration write boundaries', () => {
  it('rejects unlisted fields and malformed model handles', () => {
    const config = configuration({ id: 'a', name: 'Memo', model: 'openai/gpt-5', system: 'Help', api_key: 'secret' });
    expect(() => configurationPatch({ expectedVersion: config.version, name: 'Memo', api_key: 'changed' } as any, config)).toThrow(/valid agent configuration/);
    expect(() => configurationPatch({ expectedVersion: config.version, model: 'gpt-5' }, config)).toThrow(/provider\/model/);
    expect(() => configurationPatch({ expectedVersion: config.version, model: 'openai/gpt-5' }, { ...config, editableFields: ['name'] })).toThrow(/cannot be changed/);
  });
  it('serializes concurrent revisions and recovers after a stale writer', async () => {
    let raw = { id: 'a', name: 'Memo' }; const expectedVersion = configuration(raw).version;
    const writes = new ConfigurationWrites(); const mutation = vi.fn();
    const update = (name: string) => writes.run('a', async () => {
      const patch = configurationPatch({ name, expectedVersion }, configuration(raw));
      await Promise.resolve(); raw = { ...raw, ...patch }; mutation();
    });
    const results = await Promise.allSettled([update('First'), update('Second')]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(mutation).toHaveBeenCalledTimes(1); expect(raw.name).toBe('First');
    await writes.run('a', async () => { raw.name = 'Third'; }); expect(raw.name).toBe('Third');
  });
});
