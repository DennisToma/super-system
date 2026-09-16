import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, History, MessageSquare, Plus, Search, Sparkles, X } from 'lucide-react';
import { isTerminal, type Conversation, type Message, type Run } from '@super-system/core';
import { ApiError, errorMessage, post, query, segment } from '../api';
import { useWorkspace } from '../context';
import { usePaged, useResource } from '../hooks';
import { LiveRunCard } from '../RunView';
import { Badge, Button, CapabilityNotice, dateTime, EmptyState, ErrorNotice, Field, IconButton, Loading, LoadMore, Markdown, Modal, RunBadge, SearchField } from '../ui';

interface PendingSend { requestId: string; agentId: string; conversationId: string; message: string }
const pendingKey = 'super-system.pending-send';
function readPending(): PendingSend | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); return value && ['requestId', 'agentId', 'conversationId', 'message'].every(key => typeof value[key] === 'string' && value[key]) ? value : undefined; } catch { return undefined; }
}
function savePending(value?: PendingSend) { try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { /* In-memory recovery remains available when browser storage is disabled. */ } }
function findKnownMessage(messages: Message[], content: string, role: 'user' | 'assistant', createdAt: string) {
  return messages.some(message => message.role === role && message.content.trim() === content.trim() && (!message.createdAt || new Date(message.createdAt).getTime() >= new Date(createdAt).getTime() - 5000));
}
export function Chat() {
  const { agent, connection, conversationId, setConversationId, inspectRun, preferences } = useWorkspace();
  const supported = connection.capabilities.chat.state === 'supported';
  const conversations = usePaged<Conversation>(agent && supported ? `/conversations${query({ agentId: agent.id })}` : null);
  const messages = usePaged<Message>(agent && conversationId && supported ? `/conversations/${segment(conversationId)}/messages${query({ agentId: agent.id })}` : null);
  const runs = useResource<Run[]>(conversationId && supported ? `/runs${query({ conversationId })}` : null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [pending, setPending] = useState<PendingSend | undefined>(readPending);
  const [mobileList, setMobileList] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const previousConversation = useRef(conversationId);
  const selection = useRef(conversationId); selection.current = conversationId;
  const selected = conversations.items.find(item => item.id === conversationId);
  const activeRuns = (runs.data || []).filter(run => !isTerminal(run.status) && !run.releasedAt);
  useEffect(() => { if (!conversationId && conversations.items.length) setConversationId(conversations.items[0].id); }, [conversations.data, conversationId]);
  useEffect(() => {
    if (previousConversation.current !== conversationId) { setDraft(''); setSendError(undefined); setShowHistory(false); previousConversation.current = conversationId; nearBottom.current = true; }
  }, [conversationId]);
  useEffect(() => {
    if (nearBottom.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages.data, runs.data]);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`; } }, [draft]);
  const select = (id: string) => { setConversationId(id); setMobileList(false); };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!agent) return;
    setCreateBusy(true); setCreateError(undefined);
    try { const value = await post<Conversation>('/conversations', { agentId: agent.id, ...(newTitle.trim() ? { title: newTitle.trim() } : {}) }); conversations.refresh(); select(value.id); setCreating(false); setNewTitle(''); }
    catch (cause) { setCreateError(errorMessage(cause)); } finally { setCreateBusy(false); }
  };
  const send = async (payload?: PendingSend) => {
    if (sendBusy || (!payload && (!agent || !conversationId))) return;
    const submission = payload || { requestId: crypto.randomUUID(), agentId: agent!.id, conversationId: conversationId!, message: draft.trim() };
    if (!submission.message) return;
    setPending(submission); savePending(submission); setSendBusy(true); setSendError(undefined);
    try {
      const value = await post<Run>('/runs', submission);
      setPending(undefined); savePending(undefined);
      if (selection.current === submission.conversationId) {
        runs.setData(items => [value, ...(items || []).filter(item => item.id !== value.id)]);
        setDraft(''); nearBottom.current = true; input.current?.focus();
      }
      conversations.refresh();
    } catch (cause) {
      setSendError(errorMessage(cause));
      // Validation/auth failures are known rejections; network/5xx outcomes remain uncertain.
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) { setPending(undefined); savePending(undefined); }
    } finally { setSendBusy(false); }
  };
  const updateRun = (value: Run) => {
    if (value.conversationId !== selection.current) return;
    runs.setData(items => {
      const previous = items?.find(item => item.id === value.id);
      if (previous && previous.updatedAt === value.updatedAt && previous.status === value.status && previous.response === value.response && previous.releasedAt === value.releasedAt) return items;
      if (previous && !isTerminal(previous.status) && isTerminal(value.status)) { setTimeout(() => messages.refresh(), 250); }
      return (items || []).map(item => item.id === value.id ? value : item);
    });
  };
  const sortedMessages = [...messages.items].sort((a, b) => a.createdAt && b.createdAt ? a.createdAt.localeCompare(b.createdAt) : 0);
  const visibleRuns = [...(runs.data || [])].reverse().filter(run => !isTerminal(run.status) || !findKnownMessage(sortedMessages, run.response, 'assistant', run.createdAt) || run.status === 'failed').slice(-12);
  const currentPending = pending?.conversationId === conversationId ? pending : undefined;
  const canCompose = supported && Boolean(agent && conversationId) && !activeRuns.length && !pending;
  const filtered = conversations.items.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="chat-layout">
    <aside className={`conversation-panel ${mobileList ? 'conversation-panel-open' : ''}`} aria-label="Conversations"><div className="conversation-heading"><h2>Conversations</h2><div>{connection.capabilities.conversations.state === 'supported' && agent && <IconButton label="New conversation" onClick={() => setCreating(true)}><Plus size={18} /></IconButton>}<IconButton className="mobile-only icon-button" label="Close conversations" onClick={() => setMobileList(false)}><X size={18} /></IconButton></div></div><div className="conversation-search"><SearchField value={search} onChange={setSearch} placeholder="Find a conversation…" /></div><div className="conversation-list">{conversations.error && <ErrorNotice message={conversations.error} retry={conversations.refresh} />}{conversations.loading && !conversations.data ? <Loading label="Loading…" /> : filtered.length ? filtered.map(item => <button key={item.id} className={`conversation-row ${conversationId === item.id ? 'selected' : ''}`} onClick={() => select(item.id)}><MessageSquare size={15} /><span><strong>{item.title || 'Untitled conversation'}</strong><small>{item.updatedAt || item.createdAt ? dateTime(item.updatedAt || item.createdAt, preferences.timezone).split(',')[0] : 'Conversation'}</small></span><ChevronRight size={13} /></button>) : <div className="conversation-empty"><MessageSquare size={23} strokeWidth={1.4} /><p>{search ? 'No matches in loaded conversations.' : 'Your conversations will appear here.'}</p></div>}<LoadMore available={Boolean(conversations.nextCursor)} loading={conversations.moreLoading} onClick={conversations.loadMore} />{conversations.moreError && <ErrorNotice message={conversations.moreError} retry={conversations.loadMore} />}</div><div className="conversation-footnote"><span className={`connection-dot ${connection.status === 'connected' ? 'online' : ''}`} /><span>{agent?.name || 'No agent selected'}</span><span className="mono">{agent?.model?.split('/').at(-1)}</span></div></aside>
    <section className="chat-main"><header className="chat-header"><div><button className="conversation-toggle" onClick={() => setMobileList(true)}><MessageSquare size={16} /><ChevronDown size={13} /></button><div><h1>{selected?.title || (conversationId ? 'Conversation' : 'A conversation starts here.')}</h1><p>{agent ? `${agent.name}${agent.model ? ` · ${agent.model}` : ''}` : 'Your agent’s next chapter'}</p></div></div><div>{Boolean(runs.data?.length) && <Button variant="ghost" onClick={() => setShowHistory(value => !value)} aria-pressed={showHistory}><History size={16} /><span>Run history</span></Button>}{connection.capabilities.conversations.state === 'supported' && agent && <Button className="chat-new" onClick={() => setCreating(true)}><Plus size={15} />New</Button>}</div></header>
      {showHistory && <div className="chat-run-history"><div><strong>Workspace run history</strong><span>Recorded by this application</span><IconButton label="Close run history" onClick={() => setShowHistory(false)}><X size={15} /></IconButton></div>{runs.data?.map(run => <button key={run.id} onClick={() => inspectRun(run)}><span>{run.prompt}</span><RunBadge status={run.status} /><ChevronRight size={14} /></button>)}</div>}
      <div className="chat-scroll" ref={viewport} onScroll={() => { if (viewport.current) { nearBottom.current = viewport.current.scrollHeight - viewport.current.scrollTop - viewport.current.clientHeight < 100; setShowJump(!nearBottom.current); } }}>
        {!supported ? <CapabilityNotice capability={connection.capabilities.chat} icon={MessageSquare} title="Bring your agent into the conversation" /> : !agent ? <EmptyState icon={Sparkles} title="Choose your agent"><p>Select an agent from the sidebar to get started.</p></EmptyState> : !conversationId ? <EmptyState icon={MessageSquare} title="Good things start with a conversation"><p>Start a new conversation or pick up where you left off.</p>{connection.capabilities.conversations.state !== 'supported' && <p>{connection.capabilities.conversations.reason}</p>}</EmptyState> : <div className="message-list">
          {messages.error && <ErrorNotice message={messages.error} retry={messages.refresh} />}{runs.error && <ErrorNotice message={runs.error} retry={runs.refresh} />}
          {messages.loading && !messages.data ? <Loading label="Opening conversation…" /> : <><LoadMore available={Boolean(messages.nextCursor)} loading={messages.moreLoading} onClick={messages.loadMore} />{messages.moreError && <ErrorNotice message={messages.moreError} retry={messages.loadMore} />}{!sortedMessages.length && !runs.data?.length && <div className="conversation-welcome"><span className="welcome-symbol"><Sparkles size={31} strokeWidth={1.2} /></span><h2>What’s on your mind?</h2><p>A question, an idea, a loose thread. Start anywhere.</p><div className="prompt-suggestions">{['What do you remember about me?', 'Help me think through an idea', 'What should we work on next?'].map(prompt => <button key={prompt} onClick={() => { setDraft(prompt); input.current?.focus(); }}>{prompt}<ArrowUp size={13} /></button>)}</div></div>}
          {sortedMessages.map(message => <div key={message.id} className={`message message-${message.role}`}><div className="message-author"><span className={`avatar ${message.role === 'user' ? 'user-avatar' : 'agent-avatar'}`}>{message.role === 'user' ? 'Y' : message.role === 'tool' ? '⌘' : '✳'}</span><strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? agent.name : message.role === 'tool' ? 'Tool result' : 'System'}</strong>{message.createdAt && <time>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: preferences.timezone }).format(new Date(message.createdAt))}</time>}</div>{message.role === 'tool' ? <details className="historical-tool"><summary>View tool result <ChevronDown size={13} /></summary><pre>{message.content}</pre></details> : message.role === 'user' ? <div className="user-content">{message.content}</div> : <Markdown>{message.content}</Markdown>}{message.toolCalls?.map(call => <details className="historical-tool" key={call.id}><summary>{call.name}<ChevronDown size={13} /></summary><pre>{call.arguments}</pre></details>)}</div>)}
          {visibleRuns.map(run => <LiveRunCard key={run.id} run={run} onUpdate={updateRun} showPrompt={!findKnownMessage(sortedMessages, run.prompt, 'user', run.createdAt)} showResponse={!run.response || !findKnownMessage(sortedMessages, run.response, 'assistant', run.createdAt)} />)}</>}
        </div>}
      </div>
      {showJump && <button className="jump-bottom" onClick={() => { viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: 'smooth' }); nearBottom.current = true; }} aria-label="Jump to latest message"><ArrowDown size={17} /></button>}
      <div className="composer-area">{sendError && <ErrorNotice message={sendError} />}{pending && <div className="pending-send"><strong>{sendBusy ? 'Submitting your request…' : 'The submission has not been confirmed.'}</strong><p>{currentPending ? 'An explicit retry reuses the same request ID, so an accepted request is returned rather than duplicated.' : 'A request in another conversation is awaiting confirmation.'}</p>{!sendBusy && <Button onClick={() => send(pending)}><Check size={14} />Check / retry submission</Button>}</div>}
      <form className={`composer ${!canCompose ? 'composer-disabled' : ''}`} onSubmit={event => { event.preventDefault(); void send(); }}><textarea ref={input} aria-label="Message your agent" placeholder={activeRuns.length ? 'Your agent is working…' : conversationId ? `Message ${agent?.name || 'your agent'}…` : 'Choose a conversation to begin…'} value={draft} maxLength={100000} disabled={!canCompose || sendBusy} rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canCompose && draft.trim()) void send(); } }} /><div className="composer-bottom"><span><span className={`connection-dot ${connection.status === 'connected' ? 'online' : ''}`} />{agent?.name || 'No agent connected'}</span><button type="submit" className="send-button" disabled={!canCompose || !draft.trim() || sendBusy} aria-label="Send message" title="Send message"><ArrowUp size={18} /></button></div></form><div className="composer-note"><span>Enter to send · Shift + Enter for a new line</span><span>Work continues on your server.</span></div></div>
    </section>
    {creating && <Modal title="New conversation" onClose={() => { if (!createBusy) setCreating(false); }}><form onSubmit={create}><div className="modal-body"><p>Start a fresh thread with {agent?.name || 'your agent'}.</p>{createError && <ErrorNotice message={createError} />}<Field label="Conversation title" hint="Optional. You can start without a title."><input value={newTitle} maxLength={200} onChange={event => setNewTitle(event.target.value)} placeholder="What are we working on?" /></Field></div><div className="modal-footer"><Button type="button" disabled={createBusy} onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" variant="primary" busy={createBusy}><Plus size={15} />Create conversation</Button></div></form></Modal>}
  </div>;
}
