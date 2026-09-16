import { ProviderError, capabilities, type AgentProvider, type Connection } from '@super-system/core';
import { AppServerProvider } from './app-server.js';
import { LegacyProvider } from './legacy.js';
import { guarded, safeUrl, type ProviderOptions } from './common.js';
export type { ProviderOptions } from './common.js';

export function createProvider(options: ProviderOptions): AgentProvider {
  // Empty optional .env values mean "not configured", including SSH-only
  // App Servers whose authentication is provided by the tunnel.
  options = { ...options, agentId: options.agentId?.trim() || undefined, apiKey: options.apiKey?.trim() || undefined, serverToken: options.serverToken?.trim() || undefined };
  if (!options.baseUrl?.trim()) {
    const connection: Connection = { configured: false, status: 'unconfigured', mode: options.mode, label: 'Connect your Letta server', checkedAt: new Date().toISOString(), capabilities: capabilities('unavailable', 'Configure the existing Letta server URL and server-side credentials to continue.') };
    return new Proxy({} as AgentProvider, { get(_target, key) {
      if (key === 'checkConnection') return async () => ({ ...connection, checkedAt: new Date().toISOString() });
      if (key === 'close') return async () => {};
      return async () => { throw new ProviderError('UNCONFIGURED', 'The Letta connection has not been configured.', 503); };
    } });
  }
  safeUrl(options);
  return guarded(options.mode === 'legacy' ? new LegacyProvider(options) : new AppServerProvider(options));
}

export { testMcpConnection } from './mcp.js';
