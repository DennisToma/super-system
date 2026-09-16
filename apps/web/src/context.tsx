import { createContext, useContext } from 'react';
import type { Agent, Connection, Preferences, Run } from '@super-system/core';
export type WorkspacePage = 'home' | 'chat' | 'memory' | 'routines' | 'files' | 'system' | 'skills' | 'config' | 'gateway' | 'mcp' | 'usage' | 'agents' | 'office';
export interface WorkspaceContextValue {
  connection: Connection;
  agents: Agent[];
  agent?: Agent;
  preferences: Preferences;
  setPreferences: (next: Preferences) => Promise<void>;
  refreshConnection: () => Promise<void>;
  navigate: (page: WorkspacePage, conversationId?: string) => void;
  conversationId?: string;
  setConversationId: (id?: string) => void;
  inspectRun: (run: Run) => void;
  notify: (message: string, tone?: 'good' | 'bad') => void;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context is missing.');
  return value;
}
