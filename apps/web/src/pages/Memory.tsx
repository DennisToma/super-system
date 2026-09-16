import { useEffect, useState } from 'react';
import { ArrowLeft, Brain, Check, ChevronRight, FileText, History, LockKeyhole, Pencil, RefreshCw, Save, Search } from 'lucide-react';
import type { MemoryItem, MemoryRevision, Page } from '@super-system/core';
import { api, ApiError, errorMessage, query, segment } from '../api';
import { useWorkspace } from '../context';
import { useDebounced, usePaged, useResource } from '../hooks';
import { Badge, Button, CapabilityNotice, dateTime, EmptyState, ErrorNotice, Loading, LoadMore, Markdown, Modal, PageHeader, SearchField } from '../ui';

export function Memory() {
  const { agent, connection, preferences, notify } = useWorkspace();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const path = agent && connection.capabilities.memoryRead.state === 'supported' ? `/agents/${segment(agent.id)}/memory` : null;
  const records = usePaged<MemoryItem>(path ? `${path}${query({ query: debouncedSearch })}` : null);
  const [selected, setSelected] = useState<MemoryItem>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<MemoryItem>();
  const [showHistory, setShowHistory] = useState(false);
  const history = useResource<MemoryRevision[]>(selected && showHistory && path ? `${path}/${segment(selected.id)}/history` : null);
  useEffect(() => { setSelected(undefined); setEditing(false); setReviewing(false); setShowHistory(false); setError(undefined); }, [agent?.id]);
  const discard = () => !editing || draft === selected?.content || window.confirm('Discard your unsaved memory changes?');
  const select = (record?: MemoryItem) => { if (!discard()) return; setSelected(record); setEditing(false); setShowHistory(false); setError(undefined); setConflict(undefined); };
  const save = async () => {
    if (!selected || !path) return;
    setSaving(true); setError(undefined);
    try {
      const updated = await api<MemoryItem>(`${path}/${segment(selected.id)}`, { method: 'PATCH', body: JSON.stringify({ content: draft, expectedVersion: selected.version }) });
      setSelected(updated); setEditing(false); setReviewing(false); setConflict(undefined); records.refresh(); history.refresh(); notify('Memory updated.');
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) {
        try { const current = await api<Page<MemoryItem>>(`${path}${query({ query: selected.title })}`); const latest = current.items.find(item => item.id === selected.id); if (latest) setConflict(latest); } catch { /* Keep the draft and original version when the current record cannot be read. */ }
      }
    } finally { setSaving(false); }
  };
  const supported = connection.capabilities.memoryRead.state === 'supported';
  return <div className="page resource-page"><PageHeader eyebrow="What your agent remembers" title="A memory worth keeping." description="Inspect the context behind a conversation. Refine what matters." actions={supported && <Button onClick={records.refresh} busy={records.loading}><RefreshCw size={15} />Refresh</Button>} />
    {!supported ? <div className="panel"><CapabilityNotice capability={connection.capabilities.memoryRead} icon={Brain} title="Memory starts with a connection" /></div> : !agent ? <EmptyState icon={Brain} title="Choose an agent"><p>Select an agent from the sidebar to inspect its memory.</p></EmptyState> : <>
      <div className={`resource-layout ${selected ? 'resource-has-selection' : ''}`}><section className="panel resource-list-panel"><div className="resource-search"><SearchField value={search} onChange={setSearch} placeholder="Search memory…" /></div><div className="list-caption"><span>Memory records</span><span>{records.items.length}{records.nextCursor ? '+' : ''}</span></div>{records.error && <ErrorNotice message={records.error} retry={records.refresh} />}{records.loading && !records.data ? <Loading label="Reading memory…" /> : records.items.length ? <div className="record-list">{records.items.map(item => <button className={`record-row ${selected?.id === item.id ? 'selected' : ''}`} key={item.id} onClick={() => select(item)}><span className="record-icon">{item.kind === 'file' ? <FileText size={17} /> : <Brain size={17} />}</span><span><strong>{item.title}</strong><span>{item.description || item.content.slice(0, 90) || 'Empty record'}</span><small>{item.kind}{item.scope ? ` · ${item.scope}` : ''}</small></span><ChevronRight size={14} /></button>)}</div> : <EmptyState compact icon={search ? Search : Brain} title={search ? 'No matching memories' : 'No memory records yet'}><p>{search ? 'Try another word or clear the search.' : 'Records reported by your agent will appear here.'}</p></EmptyState>}<LoadMore available={Boolean(records.nextCursor)} loading={records.moreLoading} onClick={records.loadMore} />{records.moreError && <ErrorNotice message={records.moreError} retry={records.loadMore} />}</section>
      <section className="panel memory-detail">{selected ? <><div className="memory-detail-header"><Button className="mobile-back" variant="ghost" onClick={() => select()}><ArrowLeft size={15} />All memory</Button><div className="detail-title"><div><div className="eyebrow">{selected.kind} memory</div><h2>{selected.title}</h2></div><Badge>{selected.editable ? 'Editable' : 'Read only'}</Badge></div>{selected.description && <p>{selected.description}</p>}<div className="detail-toolbar"><Button variant="ghost" onClick={() => setShowHistory(value => !value)}><History size={14} />{showHistory ? 'Hide history' : 'Revision history'}</Button>{selected.editable && connection.capabilities.memoryWrite.state === 'supported' && !editing && <Button onClick={() => { setDraft(selected.content); setEditing(true); setError(undefined); setShowHistory(false); }}><Pencil size={14} />Edit memory</Button>}</div></div>
      {editing ? <div className="memory-edit"><label className="field"><span>Memory content</span><textarea value={draft} onChange={event => setDraft(event.target.value)} rows={15} maxLength={200000} /></label><div className="editor-footer"><span>{draft.length.toLocaleString()} characters</span><div><Button onClick={() => { if (discard()) setEditing(false); }}>Cancel</Button><Button variant="primary" disabled={draft === selected.content} onClick={() => { setReviewing(true); setConflict(undefined); setError(undefined); }}><Check size={15} />Review changes</Button></div></div></div> : <div className="memory-content"><Markdown>{selected.content || '*This memory record is empty.*'}</Markdown></div>}
      {!selected.editable && <div className="panel-footnote"><LockKeyhole size={14} />This record is provided as read only by your connection.</div>}
      {showHistory && <div className="memory-history"><h3>Observed revisions</h3><p>Changes made through this workspace. Earlier or external edits may not be included.</p>{history.error ? <ErrorNotice message={history.error} retry={history.refresh} /> : history.loading ? <Loading label="Loading revisions…" /> : history.data?.length ? history.data.map(revision => <details key={revision.id} className="revision"><summary><History size={14} /><span>{dateTime(revision.createdAt, preferences.timezone)}</span><ChevronRight size={14} /></summary><div className="comparison"><div><span>Before</span><pre>{revision.before || '(empty)'}</pre></div><div><span>After</span><pre>{revision.after || '(empty)'}</pre></div></div></details>) : <p className="empty-inline">No changes have been recorded by this workspace.</p>}</div>}
      <div className="memory-meta"><span className="mono">{selected.id}</span>{selected.updatedAt && <span>Updated {dateTime(selected.updatedAt, preferences.timezone)}</span>}</div></> : <EmptyState icon={Brain} title="A little context goes a long way"><p>Choose a memory record to see what your agent knows and how it has changed.</p></EmptyState>}</section></div>
      <div className="home-footnote"><Brain size={14} /><span>Memory belongs to your Letta agent. Edits here update the connected server.</span></div>
    </>}
    {reviewing && selected && <Modal title={conflict ? 'This memory has changed' : 'Review memory changes'} wide onClose={() => { if (!saving) setReviewing(false); }}><div className="modal-body"><p>{conflict ? 'Another change was made after you opened this record. Compare the current version with your draft before choosing a new baseline.' : 'Check your changes before updating the agent’s memory.'}</p>{error && <ErrorNotice message={error} />}<div className="comparison"><div><span>{conflict ? 'Current server version' : 'Before'}</span><pre>{(conflict || selected).content || '(empty)'}</pre></div><div><span>Your changes</span><pre>{draft || '(empty)'}</pre></div></div></div><div className="modal-footer"><Button disabled={saving} onClick={() => setReviewing(false)}>Keep editing</Button>{conflict ? <Button variant="primary" onClick={() => { setSelected(conflict); setConflict(undefined); setError(undefined); }}>Use current version as baseline</Button> : <Button variant="primary" busy={saving} onClick={save}><Save size={15} />Save memory</Button>}</div></Modal>}
  </div>;
}
