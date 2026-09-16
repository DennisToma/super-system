import { useState, type FormEvent } from 'react';
import { CalendarDays, Clock3, Globe2, Pause, Play, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { CreateRoutineInput, Routine } from '@super-system/core';
import { api, errorMessage, post, segment } from '../api';
import { useWorkspace } from '../context';
import { useResource } from '../hooks';
import { Badge, Button, CapabilityNotice, dateTime, EmptyState, ErrorNotice, Field, Loading, Modal, PageHeader } from '../ui';

export function Routines() {
  const { agent, connection, preferences, notify } = useWorkspace();
  const supported = connection.capabilities.routinesRead.state === 'supported';
  const routines = useResource<Routine[]>(agent && supported ? `/agents/${segment(agent.id)}/routines` : null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Routine>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const action = async (routine: Routine, kind: 'delete' | 'run' | 'pause') => {
    setBusy(routine.id); setError(undefined);
    const path = `/agents/${segment(routine.agentId)}/routines/${segment(routine.id)}`;
    try {
      if (kind === 'delete') await api(path, { method: 'DELETE' });
      else await post(`${path}/${kind}`, kind === 'pause' ? { paused: routine.state !== 'paused' } : undefined);
      if (kind === 'delete') setDeleting(undefined);
      notify(kind === 'delete' ? 'Routine deleted.' : kind === 'run' ? 'Run requested.' : routine.state === 'paused' ? 'Routine resumed.' : 'Routine paused.');
      routines.refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(undefined); }
  };
  return <div className="page routines-page"><PageHeader eyebrow="A little help, on repeat" title="Make room for a routine." description="Scheduled work that keeps things moving, even when you step away." actions={<>{supported && <Button onClick={routines.refresh} busy={routines.loading}><RefreshCw size={15} />Refresh</Button>}{agent && connection.capabilities.routinesWrite.state === 'supported' && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} />New routine</Button>}</>} />
    {error && !deleting && <ErrorNotice message={error} />}
    {!supported ? <section className="panel"><CapabilityNotice capability={connection.capabilities.routinesRead} icon={Clock3} title="Your routines live with your agent" /></section> : !agent ? <EmptyState icon={Clock3} title="Choose an agent"><p>Select an agent to see its scheduled work.</p></EmptyState> : routines.error ? <ErrorNotice message={routines.error} retry={routines.refresh} /> : routines.loading && !routines.data ? <Loading label="Loading routines…" /> : routines.data?.length ? <div className="routine-grid">{routines.data.map(routine => <article className="panel routine-card" key={routine.id}><div className="routine-top"><span className="routine-icon"><Clock3 size={20} strokeWidth={1.5} /></span><Badge tone={routine.state === 'active' ? 'good' : 'neutral'}>{routine.state === 'unknown' ? 'State not reported' : routine.state}</Badge></div><h2>{routine.name}</h2><p className="routine-prompt">{routine.prompt}</p><dl className="routine-details"><div><dt><CalendarDays size={14} />Schedule</dt><dd>{routine.cron ? <code>{routine.cron}</code> : dateTime(routine.scheduledAt, routine.timezone)}</dd></div><div><dt><Globe2 size={14} />Timezone</dt><dd>{routine.timezone}</dd></div><div><dt><Server size={14} />Target</dt><dd>{routine.executionTarget || 'Not reported by server'}</dd></div><div><dt>Next run</dt><dd>{dateTime(routine.nextRunAt, preferences.timezone)}</dd></div>{routine.lastRunAt && <div><dt>Last run</dt><dd>{dateTime(routine.lastRunAt, preferences.timezone)}</dd></div>}</dl><div className="routine-actions">{connection.capabilities.routineRun.state === 'supported' && <Button busy={busy === routine.id} onClick={() => action(routine, 'run')}><Play size={14} />Run now</Button>}{connection.capabilities.routinePause.state === 'supported' && routine.state !== 'unknown' && <Button disabled={busy === routine.id} onClick={() => action(routine, 'pause')}>{routine.state === 'paused' ? <Play size={14} /> : <Pause size={14} />}{routine.state === 'paused' ? 'Resume' : 'Pause'}</Button>}{connection.capabilities.routinesWrite.state === 'supported' && <button className="icon-button routine-delete" aria-label={`Delete ${routine.name}`} title="Delete routine" disabled={busy === routine.id} onClick={() => { setDeleting(routine); setError(undefined); }}><Trash2 size={15} /></button>}</div></article>)}</div> : <section className="panel"><EmptyState icon={Clock3} title="A rhythm of its own"><p>Create a routine for the work you keep coming back to. Your server owns the schedule.</p>{connection.capabilities.routinesWrite.state !== 'supported' && <p>{connection.capabilities.routinesWrite.reason || 'Routine creation is not available on this connection.'}</p>}</EmptyState></section>}
    <div className="info-strip"><Clock3 size={17} /><p>Routines run on your Letta server’s schedule. Closing this workspace does not pause them. Execution targets and offline behavior depend on your server.</p></div>
    {creating && agent && <RoutineForm agentId={agent.id} timezone={preferences.timezone} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); routines.refresh(); notify('Routine created.'); }} />}
    {deleting && <Modal title="Delete this routine?" onClose={() => { if (!busy) setDeleting(undefined); }}><div className="modal-body"><p><strong>{deleting.name}</strong> will be removed from the Letta server. Its future scheduled runs will stop.</p>{error && <ErrorNotice message={error} />}</div><div className="modal-footer"><Button disabled={Boolean(busy)} onClick={() => setDeleting(undefined)}>Keep routine</Button><Button variant="danger" busy={Boolean(busy)} onClick={() => action(deleting, 'delete')}><Trash2 size={15} />Delete routine</Button></div></Modal>}
  </div>;
}
function RoutineForm({ agentId, timezone, onClose, onCreated }: { agentId: string; timezone: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'recurring' | 'once'>('recurring');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [date, setDate] = useState('');
  const [zone, setZone] = useState(timezone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(undefined);
    try { new Intl.DateTimeFormat(undefined, { timeZone: zone }); } catch { setError('Enter a valid IANA timezone, such as Europe/Vienna.'); return; }
    if (kind === 'recurring' && cron.trim().split(/\s+/).length !== 5) { setError('Use a five-field cron expression: minute, hour, day, month, weekday.'); return; }
    if (kind === 'once' && (!date || new Date(date).getTime() <= Date.now())) { setError('Choose a date and time in the future.'); return; }
    const input: CreateRoutineInput = { agentId, name: name.trim(), prompt: prompt.trim(), timezone: zone, ...(kind === 'recurring' ? { cron: cron.trim() } : { scheduledAt: new Date(date).toISOString() }) };
    setSaving(true);
    try { await post('/routines', input); onCreated(); } catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  };
  return <Modal title="Create a routine" onClose={() => { if (!saving) onClose(); }}><form onSubmit={submit}><div className="modal-body form-stack"><p>Give your agent a task and a time to come back to it.</p>{error && <ErrorNotice message={error} />}<Field label="Name"><input required maxLength={150} value={name} onChange={event => setName(event.target.value)} placeholder="Morning briefing" /></Field><Field label="What should your agent do?"><textarea required rows={4} maxLength={20000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Review my priorities and prepare a short briefing…" /></Field><fieldset className="segmented-field"><legend>Schedule type</legend><div className="segmented-control"><button type="button" aria-pressed={kind === 'recurring'} className={kind === 'recurring' ? 'selected' : ''} onClick={() => setKind('recurring')}>Recurring</button><button type="button" aria-pressed={kind === 'once'} className={kind === 'once' ? 'selected' : ''} onClick={() => setKind('once')}>One time</button></div></fieldset>{kind === 'recurring' ? <><Field label="Cron expression" hint="Minute · hour · day of month · month · day of week"><input className="mono" required value={cron} onChange={event => setCron(event.target.value)} /></Field><div className="preset-list"><button type="button" onClick={() => setCron('0 9 * * 1-5')}>Weekdays at 9</button><button type="button" onClick={() => setCron('0 9 * * *')}>Daily at 9</button><button type="button" onClick={() => setCron('0 9 * * 1')}>Mondays at 9</button></div></> : <Field label="Date and time" hint={`Entered in your device timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Sent to the server as an exact instant.`}><input required type="datetime-local" value={date} onChange={event => setDate(event.target.value)} /></Field>}<Field label="Schedule timezone" hint="Your server validates which schedule timezones it supports."><input required value={zone} onChange={event => setZone(event.target.value)} placeholder="Europe/Vienna" /></Field></div><div className="modal-footer"><Button type="button" disabled={saving} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={saving}><Plus size={15} />Create routine</Button></div></form></Modal>;
}
