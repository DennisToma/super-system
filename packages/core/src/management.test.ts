import { describe, expect, it } from 'vitest';
import { agentConfigPatchSchema, mcpInputSchema, skillInputSchema, taskInputSchema } from './index.js';

describe('control room inputs', () => {
  it('keeps newly configured integrations disabled until explicitly enabled', () => {
    expect(mcpInputSchema.parse({ name: 'notes', transport: 'stdio', command: 'node' }).enabled).toBe(false);
    expect(skillInputSchema.parse({ name: 'Briefing', content: 'Summarize open work.' })).toMatchObject({ enabled: false, agentIds: [] });
  });
  it.each(['https://user:secret@example.test/mcp', 'https://example.test/mcp?key=secret', 'file:///tmp/socket'])('rejects an endpoint that can expose credentials or use another protocol: %s', url => {
    expect(mcpInputSchema.safeParse({ name: 'notes', transport: 'http', url }).success).toBe(false);
  });
  it('rejects ambiguous transport configuration', () => {
    expect(mcpInputSchema.safeParse({ name: 'notes', transport: 'http', url: 'https://example.test/mcp', command: 'node' }).success).toBe(false);
    expect(mcpInputSchema.safeParse({ name: 'notes', transport: 'stdio', command: 'node', headers: { Authorization: 'secret' } }).success).toBe(false);
  });
  it('rejects empty work and stale-editor requests without a revision', () => {
    expect(taskInputSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(agentConfigPatchSchema.safeParse({ name: 'Memo' }).success).toBe(false);
    expect(agentConfigPatchSchema.safeParse({ expectedVersion: 'v1' }).success).toBe(false);
  });
});
