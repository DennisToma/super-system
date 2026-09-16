import { useEffect, useState, type ReactNode } from 'react';
import type { Agent } from '@super-system/core';
import { errorMessage } from './api';
import { useResource } from './hooks';
import { Button, ErrorNotice, Modal } from './ui';

export function usePollingResource<T>(path: string, interval = 15000) {
  const resource = useResource<T>(path);
  useEffect(() => {
    if (resource.loading) return;
    const timer = setTimeout(() => { if (!document.hidden) resource.refresh(); }, interval);
    const visible = () => { if (!document.hidden) resource.refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [resource.loading, resource.data, resource.error, resource.refresh, interval, path]);
  return resource;
}
export function AgentAssignments({ agents, value, onChange }: { agents: Agent[]; value: string[]; onChange: (ids: string[]) => void }) {
  return <fieldset className="assignment-field"><legend>Assigned agents</legend><p>Only these agents use this in new workspace runs.</p>{agents.length ? agents.map(agent => <label className="check-row" key={agent.id}><input type="checkbox" checked={value.includes(agent.id)} onChange={event => onChange(event.target.checked ? [...value, agent.id] : value.filter(id => id !== agent.id))} /><span>{agent.name}<small className="mono">{agent.id.slice(-8)}</small></span></label>) : <p>Connect an agent to assign it later.</p>}</fieldset>;
}
export function DeleteDialog({ title, children, onClose, onDelete }: { title: string; children: ReactNode; onClose: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }}><div className="modal-body">{children}{error && <ErrorNotice message={error} />}</div><div className="modal-footer"><Button disabled={busy} onClick={onClose}>Keep it</Button><Button variant="danger" busy={busy} onClick={async () => { setBusy(true); try { await onDelete(); onClose(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }}>Delete</Button></div></Modal>;
}
export const formatCount = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString();
export function Metrics({ values }: { values: { label: string; value: string; detail?: string }[] }) {
  return <div className="control-metrics">{values.map(item => <div className="control-metric" key={item.label}><span>{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</div>)}</div>;
}
