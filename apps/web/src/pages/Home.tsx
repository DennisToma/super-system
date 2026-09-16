import { ArrowDownLeft, ArrowRight, Brain, Check, Clock3, FileText, MessageSquare, PlugZap, Settings2, Sparkles, Workflow } from 'lucide-react';
import type { Overview } from '@super-system/core';
import { useWorkspace } from '../context';
import { useResource } from '../hooks';
import { query } from '../api';
import { Badge, Button, EmptyState, ErrorNotice, PageHeader, relativeTime, RunBadge } from '../ui';

export function Home() {
  const { agent, connection, navigate, inspectRun } = useWorkspace();
  const overview = useResource<Overview>(`/overview${query({ agentId: agent?.id })}`);
  const needsAttention = overview.data?.recentRuns.filter(run => ['waiting_for_approval', 'interrupted', 'failed'].includes(run.status)) || [];
  const connected = connection.status === 'connected';
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  const metrics = [
    { name: 'Conversations', icon: MessageSquare, value: overview.data?.counts.conversations, page: 'chat' as const },
    { name: 'Memory records', icon: Brain, value: overview.data?.counts.memory, page: 'memory' as const },
    { name: 'Routines', icon: Clock3, value: overview.data?.counts.routines, page: 'routines' as const },
    { name: 'Attached files', icon: FileText, value: overview.data?.counts.files, page: 'files' as const },
  ];
  return <div className="page home-page">
    <PageHeader eyebrow={date} title="Your agent, in view." description="A clear space for conversations, memory, and everything in motion." />
    {overview.error && <ErrorNotice message={overview.error} retry={overview.refresh} />}
    <section className={`hero-card ${connected ? 'hero-connected' : ''}`}>
      <div className="hero-copy"><div className="eyebrow"><span className={`connection-dot ${connected ? 'online' : ''}`} />{connected ? 'Connected to your workspace' : 'Make yourself at home'}</div>
        <h2>{connected ? `${agent?.name || 'Your agent'} is here.` : 'Your agent.\nAll in one place.'}</h2>
        <p>{connected ? 'Pick up a conversation, check a memory, or see what your agent has been working on.' : 'Connect your existing Letta server to bring its conversations, memories, and work into focus.'}</p>
        <Button variant="primary" onClick={() => navigate(connected ? 'chat' : 'system')}>{connected ? 'Open a conversation' : 'Connect your server'} <ArrowRight size={16} /></Button>
      </div>
      <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-center"><Sparkles size={42} strokeWidth={1.1} /></div><div className="orbit-node node-memory"><Brain size={22} strokeWidth={1.5} /></div><div className="orbit-node node-chat"><MessageSquare size={22} strokeWidth={1.5} /></div><div className="orbit-node node-routine"><Workflow size={22} strokeWidth={1.5} /></div><span className="art-dot dot-one" /><span className="art-dot dot-two" /></div>
    </section>
    <section className="metric-grid" aria-label="Workspace counts">{metrics.map(({ name, icon: Icon, value, page }) => <button key={name} className="metric-card" onClick={() => navigate(page)}><span className="metric-top"><Icon size={18} strokeWidth={1.6} /><ArrowDownLeft size={15} /></span><strong>{value === undefined || value === null ? '—' : value.toLocaleString()}</strong><span>{name}</span>{value === null && <small>Not available</small>}</button>)}</section>
    <div className="home-columns"><section className="panel activity-panel"><div className="section-heading"><div><h2>Recent activity</h2><p>The latest from your workspace.</p></div><Badge>{overview.data?.activity.length || 0} events</Badge></div>
      {overview.data?.activity.length ? <div className="activity-list">{overview.data.activity.slice(0, 8).map(item => { const run = overview.data?.recentRuns.find(value => value.id === item.runId); return <button className="activity-row" key={item.id} disabled={!run} onClick={() => run && inspectRun(run)}><span className={`activity-symbol activity-${item.type}`}>{item.type === 'memory' ? <Brain size={16} /> : item.type === 'routine' ? <Clock3 size={16} /> : item.type === 'system' ? <Settings2 size={16} /> : <MessageSquare size={16} />}</span><span className="activity-text"><strong>{item.title}</strong><span>{item.description || (item.status ? item.status.replaceAll('_', ' ') : 'Workspace update')}</span></span><time title={item.createdAt}>{relativeTime(item.createdAt)}</time>{run && <ArrowRight size={14} />}</button>; })}</div> : <EmptyState compact icon={Workflow} title="A fresh start"><p>Your conversations and changes will leave a trail here.</p></EmptyState>}
    </section><section className="panel attention-panel"><div className="section-heading"><div><h2>{connected ? 'Needs your attention' : 'A simple first step'}</h2><p>{connected ? 'Decisions and work to follow up on.' : 'Bring your existing agent with you.'}</p></div></div>
      {!connected ? <div className="setup-summary"><div className="setup-step"><span>01</span><div><strong>Connect to Letta</strong><p>Use your Hetzner server’s address and credentials.</p></div></div><div className="setup-step"><span>02</span><div><strong>Choose your agent</strong><p>Keep its existing identity, memory, and history.</p></div></div><div className="setup-step"><span>03</span><div><strong>Pick up the conversation</strong><p>One workspace, in your browser or on your desktop.</p></div></div><button className="text-link" onClick={() => navigate('system')}>Open connection settings <ArrowRight size={15} /></button></div> : needsAttention.length ? <div className="attention-list">{needsAttention.map(run => <button key={run.id} onClick={() => inspectRun(run)}><RunBadge status={run.status} /><strong>{run.prompt}</strong><span>{relativeTime(run.updatedAt)} <ArrowRight size={14} /></span></button>)}</div> : <EmptyState compact icon={Check} title="You’re all caught up"><p>Approvals and work that needs a second look will appear here.</p></EmptyState>}
    </section></div>
    <div className="home-footnote"><PlugZap size={14} /><span>{connected ? 'Your agent runs on your server. This is your window into its work.' : 'Made for your existing Letta agent. No new agent is created when you connect.'}</span></div>
  </div>;
}
