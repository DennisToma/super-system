import { agentConfigFields, agentConfigPatchSchema, measurement, ProviderError, type AgentConfiguration, type AgentConfigPatch, type RunResources, type UsageMeasurement } from '@super-system/core';
import { hash, record, str } from './common.js';

export function configuration(raw: unknown, editableFields: AgentConfiguration['editableFields'] = [...agentConfigFields]): AgentConfiguration {
  const agent = record(raw);
  if (typeof agent.id !== 'string') throw new ProviderError('PROVIDER_PROTOCOL', 'Letta returned incomplete agent configuration.', 502);
  const fields = { agentId: agent.id, name: str(agent.name) ?? agent.id, description: str(agent.description) ?? '', model: str(agent.model) ?? str(record(agent.llm_config).model) ?? '', system: str(agent.system) ?? '' };
  return { ...fields, version: hash(JSON.stringify(fields)), editableFields };
}
export function configurationPatch(patch: AgentConfigPatch, current: AgentConfiguration) {
  const parsed = agentConfigPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ProviderError('VALIDATION', 'Choose valid agent configuration fields and a current version.', 400);
  if (current.version !== parsed.data.expectedVersion) throw new ProviderError('CONFLICT', 'This agent configuration changed. Refresh it before saving again.', 409);
  const fields: Omit<AgentConfigPatch, 'expectedVersion'> = {};
  for (const key of agentConfigFields) {
    if (parsed.data[key] === undefined) continue;
    if (!current.editableFields.includes(key)) throw new ProviderError('UNSUPPORTED', 'This configuration field cannot be changed through this connection.', 501);
    fields[key] = parsed.data[key];
  }
  if (fields.model !== undefined && !/^[^\s/]+\/[^\s]+$/.test(fields.model)) throw new ProviderError('VALIDATION', 'Use the complete provider/model identifier.', 400);
  return fields;
}
/** Serialize application writes so two requests with the same revision cannot both pass. */
export class ConfigurationWrites {
  private pending = new Map<string, Promise<unknown>>();
  async run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(agentId, next);
    try { return await next; } finally { if (this.pending.get(agentId) === next) this.pending.delete(agentId); }
  }
}
export function resourcePrompt(message: string, resources?: RunResources): string {
  if (!resources?.skills.length) return message;
  return `Workspace instructions for this run:\n\n${resources.skills.map(skill => `## ${skill.name}\n${skill.content}`).join('\n\n')}\n\nUser request:\n${message}`;
}
export function addUsage(target: UsageMeasurement, raw: unknown) {
  const source = record(raw);
  for (const [field, key] of [['inputTokens', 'prompt_tokens'], ['outputTokens', 'completion_tokens'], ['totalTokens', 'total_tokens']] as const) {
    const value = measurement(source[key]);
    if (value !== undefined) target[field] = (target[field] ?? 0) + value;
  }
}
