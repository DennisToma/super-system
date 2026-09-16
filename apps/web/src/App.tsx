import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, ArrowRight, Brain, Check, ChevronDown, ChevronRight, Clock3, Command, FileText, House, LogOut, Menu, MessageSquare, Moon, PanelLeftClose, RefreshCw, Settings2, ShieldCheck, Sun, X } from 'lucide-react';
import type { Activity as ActivityItem, Agent, Connection, Preferences, Run } from '@super-system/core';
import { api, errorMessage, post, segment } from './api';
import { WorkspaceContext, type WorkspacePage } from './context';
import { useResource } from './hooks';
import { RunInspector } from './RunView';
import { Badge, Button, EmptyState, ErrorNotice, Field, IconButton, Loading, relativeTime } from './ui';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { Memory } from './pages/Memory';
import { Routines } from './pages/Routines';
import { Files } from './pages/Files';
import { System } from './pages/System';

const navigation = [
  { id: 'home', label: 'Home', icon: House }, { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain }, { id: 'routines', label: 'Routines', icon: Clock3 },
  { id: 'files', label: 'Files', icon: FileText }, { id: 'system', label: 'System', icon: Settings2 },
] as const;
const currentPage = (): WorkspacePage => { const name = location.hash.replace('#', ''); return navigation.some(item => item.id === name) ? name as WorkspacePage : 'home'; };
const defaultPreferences: Preferences = { theme: 'system', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
function Brand({ large = false }: { large?: boolean }) { return <div className={`brand ${large ? 'brand-large' : ''}`}><span className="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 7h16v6H14v6h10v6H8v-6h10v-6H8z" fill="currentColor" /></svg></span><span>super<span className="brand-light">system</span><small>YOUR AGENT WORKSPACE</small></span></div>; }
export function App() {
  const session = useResource<{ authenticated: boolean; required: boolean }>('/auth/session');
  useEffect(() => { const expire = () => session.refresh(); window.addEventListener('session-expired', expire); return () => window.removeEventListener('session-expired', expire); }, [session.refresh]);
  if (session.error) return <main className="boot-screen"><Brand large /><ErrorNotice message={session.error} retry={session.refresh} /><p>Check that the application server is running and try again.</p></main>;
  if (!session.data) return <main className="boot-screen"><Brand large /><Loading label="Opening your workspace…" /></main>;
  if (!session.data.authenticated) return <Login onSuccess={session.refresh} />;
  return <Workspace authRequired={session.data.required} onLogout={session.refresh} />;
}
function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { await post('/auth/login', { password }); setPassword(''); onSuccess(); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } };
  return <main className="login-screen"><div className="login-decoration" aria-hidden="true"><span /><span /><span /></div><div className="login-content"><Brand large /><div className="login-card"><span className="eyebrow">A space of your own</span><h1>Welcome back.</h1><p>Your agent and its memories are waiting.</p><form onSubmit={submit}>{error && <ErrorNotice message={error} />}<Field label="Workspace password"><input type="password" required autoComplete="current-password" autoFocus value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password" /></Field><Button type="submit" variant="primary" busy={busy}>Open workspace <ArrowRight size={16} /></Button></form><div className="login-note"><ShieldCheck size={14} />A private connection to your agent.</div></div><span className="login-footer">Thoughtful tools. A little more headspace.</span></div></main>;
}
function Workspace({ authRequired, onLogout }: { authRequired: boolean; onLogout: () => void }) {
  const [page, setPage] = useState<WorkspacePage>(currentPage);
  const [connection, setConnection] = useState<Connection>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [preferences, setPrefs] = useState<Preferences>(defaultPreferences);
  const [bootError, setBootError] = useState<string>();
  const [agentError, setAgentError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [conversationId, setConversationIdState] = useState<string>();
  const [inspectedRun, inspectRun] = useState<Run>();
  const [toast, setToast] = useState<{ message: string; tone: 'good' | 'bad' }>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const agent = agents.find(item => item.id === preferences.selectedAgentId) || agents[0];
  const notify = useCallback((message: string, tone: 'good' | 'bad' = 'good') => { setToast({ message, tone }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(undefined), tone === 'bad' ? 9000 : 4500); }, []);
  useEffect(() => { return () => { if (toastTimer.current) clearTimeout(toastTimer.current); }; }, []);
  useEffect(() => {
    let disposed = false;
    setBootError(undefined);
    void Promise.allSettled([api<Connection>('/connection'), api<Agent[]>('/agents'), api<Preferences>('/preferences')]).then(([connectionResult, agentResult, prefsResult]) => {
      if (disposed) return;
      if (connectionResult.status === 'rejected') { setBootError(errorMessage(connectionResult.reason)); return; }
      setConnection(connectionResult.value);
      if (agentResult.status === 'fulfilled') { setAgents(agentResult.value); setAgentError(undefined); } else { setAgentError(errorMessage(agentResult.reason)); }
      if (prefsResult.status === 'fulfilled') setPrefs(prefsResult.value); else notify('Preferences could not be loaded. Default appearance is being used.', 'bad');
    });
    return () => { disposed = true; };
  }, [revision, notify]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = preferences.theme === 'system' ? media.matches ? 'dark' : 'light' : preferences.theme; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [preferences.theme]);
  useEffect(() => { const listener = () => setPage(currentPage()); window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);
  useEffect(() => {
    if (!agent) return;
    try { const saved = JSON.parse(sessionStorage.getItem('super-system.conversation') || 'null'); setConversationIdState(saved?.agentId === agent.id ? saved.id : undefined); } catch { setConversationIdState(undefined); }
  }, [agent?.id]);
  useEffect(() => { document.title = `${navigation.find(item => item.id === page)?.label} — Super System`; }, [page]);
  const setConversationId = useCallback((id?: string) => { setConversationIdState(id); try { sessionStorage.setItem('super-system.conversation', JSON.stringify({ agentId: agent?.id, id })); } catch { /* Storage is optional for browsing. */ } }, [agent?.id]);
  const navigate = useCallback((next: WorkspacePage, nextConversation?: string) => { if (nextConversation) setConversationId(nextConversation); location.hash = next; setPage(next); setSidebarOpen(false); }, [setConversationId]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSidebarOpen(false); setActivityOpen(false); } if ((event.metaKey || event.ctrlKey) && event.altKey && /^[1-6]$/.test(event.key)) { event.preventDefault(); navigate(navigation[Number(event.key) - 1].id); } };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [navigate]);
  const setPreferences = async (next: Preferences) => { const saved = await api<Preferences>('/preferences', { method: 'PUT', body: JSON.stringify(next) }); setPrefs(saved); };
  const refreshConnection = async () => {
    const next = await post<Connection>('/connection/check'); setConnection(next);
    try { setAgents(await api<Agent[]>('/agents')); setAgentError(undefined); } catch (cause) { setAgentError(errorMessage(cause)); }
    notify(next.status === 'connected' ? 'Connection checked. Your server is available.' : next.status === 'unconfigured' ? 'Add your Letta connection to the server’s .env file.' : next.error || 'The Letta server could not be reached.', next.status === 'error' ? 'bad' : 'good');
  };
  const logout = async () => { try { await post('/auth/logout'); onLogout(); } catch (cause) { notify(errorMessage(cause), 'bad'); } };
  if (bootError || !connection) return <main className="boot-screen"><Brand large />{bootError ? <ErrorNotice message={bootError} retry={() => setRevision(value => value + 1)} /> : <Loading label="Getting things ready…" />}</main>;
  const Page = { home: Home, chat: Chat, memory: Memory, routines: Routines, files: Files, system: System }[page];
  return <WorkspaceContext.Provider value={{ connection, agents, agent, preferences, setPreferences, refreshConnection, navigate, conversationId, setConversationId, inspectRun, notify }}><div className={`app-shell ${activityOpen ? 'inspector-open' : ''}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation"><div className="sidebar-brand"><Brand /><IconButton label="Close navigation" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></IconButton></div>
      <div className="workspace-switcher"><span className="workspace-avatar">D<span /></span><div><strong>Personal workspace</strong><small>{authRequired ? 'Private workspace' : 'Local workspace'}</small></div><ShieldCheck size={15} /></div>
      <div className="nav-group-label">WORKSPACE <span>⌥ ⌘ 1–6</span></div><nav>{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{page === id && <span className="nav-active-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="agent-switcher"><label htmlFor="agent-select">YOUR AGENT</label><div className="agent-select-wrap"><span className="agent-symbol">✳</span>{agents.length ? <select id="agent-select" title={agent?.description || agent?.id} aria-label="Selected agent" value={agent?.id || ''} onChange={event => { void setPreferences({ ...preferences, selectedAgentId: event.target.value }).catch(cause => notify(errorMessage(cause), 'bad')); }}>{agents.map(item => <option key={item.id} value={item.id}>{item.name}{agents.some(other => other.id !== item.id && other.name === item.name) ? ` · ${item.id.slice(-8)}` : ''}</option>)}</select> : <button onClick={() => navigate('system')}>Connect an agent</button>}<ChevronDown size={14} /></div><div className="agent-status" title={agentError || connection.error}><span className={`connection-dot ${connection.status === 'connected' ? 'online' : ''}`} /><span>{connection.status === 'connected' ? 'Connected' : connection.status === 'error' ? 'Connection needs attention' : 'Waiting for a connection'}</span></div>{agentError && connection.status === 'connected' && <span className="agent-error">Could not load agents. Check System.</span>}</div>
        <div className="sidebar-footer"><span>Made for a clearer mind.</span><IconButton label={preferences.theme === 'dark' ? 'Use light appearance' : 'Use dark appearance'} onClick={() => { void setPreferences({ ...preferences, theme: preferences.theme === 'dark' ? 'light' : 'dark' }).catch(cause => notify(errorMessage(cause), 'bad')); }}>{preferences.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</IconButton>{authRequired && <IconButton label="Sign out" onClick={logout}><LogOut size={15} /></IconButton>}</div>
      </div>
    </aside>
    <div className="workspace-main"><div className="topbar"><div><IconButton label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19} /></IconButton><span className="breadcrumb-workspace">Personal workspace</span><ChevronRight size={12} /><span>{navigation.find(item => item.id === page)?.label}</span></div><div><span className="topbar-status"><span className={`connection-dot ${connection.status === 'connected' ? 'online' : ''}`} />{connection.status === 'connected' ? 'Connected' : 'Not connected'}</span><span className="topbar-divider" /><button className={`activity-toggle ${activityOpen ? 'selected' : ''}`} onClick={() => setActivityOpen(value => !value)} aria-expanded={activityOpen}><Activity size={16} /><span>Activity</span></button></div></div>
      <main id="main-content" tabIndex={-1} className={`main-content ${page === 'chat' ? 'main-chat' : ''}`}><Page key={`${page}-${agent?.id || 'none'}`} /></main>
    </div>
    {activityOpen && <ActivityPanel onClose={() => setActivityOpen(false)} />}
    {inspectedRun && <RunInspector initial={inspectedRun} onClose={() => inspectRun(undefined)} />}
    {toast && <div className={`toast toast-${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'}>{toast.tone === 'good' ? <Check size={17} /> : <ShieldCheck size={17} />}<span>{toast.message}</span><IconButton label="Dismiss notification" onClick={() => setToast(undefined)}><X size={15} /></IconButton></div>}
  </div></WorkspaceContext.Provider>;
}
function ActivityPanel({ onClose }: { onClose: () => void }) {
  const activity = useResource<ActivityItem[]>('/activity');
  const { inspectRun, notify } = useWorkspaceLocal();
  useEffect(() => { const interval = setInterval(activity.refresh, 10000); return () => clearInterval(interval); }, [activity.refresh]);
  const open = async (item: ActivityItem) => { if (!item.runId) return; try { inspectRun(await api<Run>(`/runs/${segment(item.runId)}`)); } catch (cause) { notify(errorMessage(cause), 'bad'); } };
  return <aside className="activity-inspector" aria-label="Activity inspector"><header><div><Activity size={17} /><h2>Activity</h2></div><IconButton label="Close activity" onClick={onClose}><X size={18} /></IconButton></header><div className="inspector-intro"><span className="eyebrow">The working thread</span><p>Changes and work across your workspace.</p></div>{activity.error && <ErrorNotice message={activity.error} retry={activity.refresh} />}{activity.loading && !activity.data ? <Loading /> : activity.data?.length ? <div className="inspector-activity">{activity.data.map(item => <button key={item.id} onClick={() => open(item)} disabled={!item.runId}><span className="timeline-dot" /><div><time>{relativeTime(item.createdAt)}</time><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}{item.status && <Badge tone={item.status === 'completed' ? 'good' : item.status === 'failed' ? 'bad' : 'neutral'}>{item.status.replaceAll('_', ' ')}</Badge>}</div></button>)}</div> : <EmptyState compact icon={Activity} title="Quiet for now"><p>New work and updates will appear here.</p></EmptyState>}<div className="inspector-bottom"><Command size={13} />History recorded by this workspace.</div></aside>;
}
// Kept here to avoid passing workspace actions through every shell component.
import { useWorkspace as useWorkspaceLocal } from './context';
