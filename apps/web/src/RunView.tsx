import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, Clock3, RefreshCw, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import { isTerminal, type Run, type RunEvent } from '@super-system/core';
import { errorMessage, post, segment } from './api';
import { useWorkspace } from './context';
import { useRunStream } from './hooks';
import { Badge, Button, dateTime, ErrorNotice, Markdown, Modal, RunBadge } from './ui';

export function ToolEvents({ events }: { events: RunEvent[] }) {
  const calls = [...new Map(events.filter(event => event.payload.type === 'tool_call').map(event => [event.payload.type === 'tool_call' ? event.payload.toolCall.id : event.id, event])).values()];
  if (!calls.length) return null;
  return <div className="tool-events">{calls.map(event => {
    if (event.payload.type !== 'tool_call') return null;
    const call = event.payload.toolCall;
    const result = [...events].reverse().find(item => item.payload.type === 'tool_result' && item.payload.toolCallId === call.id);
    return <details className="tool-event" key={call.id}><summary><Terminal size={14} /><span>{call.name}</span><Badge tone={result?.payload.type === 'tool_result' && result.payload.isError ? 'bad' : result ? 'good' : 'neutral'}>{result?.payload.type === 'tool_result' && result.payload.isError ? 'Failed' : result ? 'Finished' : call.status || 'Called'}</Badge><ChevronDown size={14} /></summary><div><span className="quiet-label">Arguments</span><pre>{formatJSON(call.arguments)}</pre>{result?.payload.type === 'tool_result' && <><span className="quiet-label">Result</span><pre>{result.payload.content}</pre></>}</div></details>;
  })}</div>;
}
const formatJSON = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
export function RunControls({ run, onUpdate }: { run: Run; onUpdate: (value: Run) => void }) {
  const { connection, notify } = useWorkspace();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmRelease, setConfirmRelease] = useState(false);
  const action = async (kind: 'cancel' | 'approval' | 'reconcile' | 'release', approved?: boolean) => {
    setBusy(kind); setError(undefined);
    try {
      const value = await post<Run>(`/runs/${segment(run.id)}/${kind}`, kind === 'approval' ? { approvalId: run.approval?.id, approved } : kind === 'release' ? { acknowledged: true } : undefined);
      onUpdate(value);
      if (kind === 'release') { setConfirmRelease(false); notify('You can send a new message. The previous outcome is still recorded as uncertain.'); }
      if (kind === 'reconcile') notify(value.status === 'interrupted' ? 'The server has not confirmed the outcome yet.' : 'Run status updated.');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(undefined); }
  };
  return <>{run.status === 'waiting_for_approval' && <div className="approval-card"><div className="approval-heading"><ShieldCheck size={18} /><strong>Your approval is needed</strong></div><p>{run.approval?.description || 'Review this tool call before the agent continues.'}</p>{run.approval && <><code>{run.approval.toolName}</code><pre>{formatJSON(run.approval.arguments)}</pre></>}{connection.capabilities.approvals.state === 'supported' && run.approval ? <div><Button disabled={Boolean(busy)} onClick={() => action('approval', false)}><X size={14} />Deny</Button><Button variant="primary" busy={busy === 'approval'} onClick={() => action('approval', true)}><Check size={14} />Approve</Button></div> : <p className="quiet-label">{connection.capabilities.approvals.reason || 'Complete this approval in your Letta server interface.'}</p>}</div>}
    {(run.status === 'interrupted' || run.status === 'cancelling') && <div className="interrupted-card"><AlertCircle size={17} /><div><strong>{run.releasedAt ? 'Reviewed by you. Outcome remains uncertain.' : run.status === 'cancelling' ? 'Waiting for cancellation to be confirmed.' : 'The outcome needs a check.'}</strong><p>{run.status === 'cancelling' ? 'The stop request was accepted. The provider has not yet confirmed that the work ended.' : run.releasedAt ? 'A new message is allowed. This action did not cancel or resend the previous work.' : 'The connection ended before the result was confirmed. Check the server before sending this request again.'}</p><Button disabled={Boolean(busy)} busy={busy === 'reconcile'} onClick={() => action('reconcile')}><RefreshCw size={14} />Check server state</Button>{run.status === 'interrupted' && !run.releasedAt && <Button disabled={Boolean(busy)} onClick={() => setConfirmRelease(true)}>Allow a new message</Button>}</div></div>}
    {run.error && <ErrorNotice message={run.error} />}{error && <ErrorNotice message={error} />}
    {connection.capabilities.cancel.state === 'supported' && !isTerminal(run.status) && !['interrupted', 'cancelling'].includes(run.status) && <div className="run-controls"><Button busy={busy === 'cancel'} onClick={() => action('cancel')}><Square size={12} />Stop run</Button></div>}
    {confirmRelease && <Modal title="Allow a new message?" onClose={() => { if (!busy) setConfirmRelease(false); }}><div className="modal-body"><p>First check this conversation in Letta and review any work or tool calls that may still be running. Continuing here will allow a new message while keeping the previous result marked as uncertain. It does not stop or repeat the original work.</p>{error && <ErrorNotice message={error} />}</div><div className="modal-footer"><Button disabled={Boolean(busy)} onClick={() => setConfirmRelease(false)}>Go back</Button><Button variant="primary" busy={busy === 'release'} onClick={() => action('release')}>I checked Letta — allow a new message</Button></div></Modal>}
  </>;
}
export function LiveRunCard({ run, onUpdate, showPrompt = true, showResponse = true }: { run: Run; onUpdate: (value: Run) => void; showPrompt?: boolean; showResponse?: boolean }) {
  const { agent, inspectRun } = useWorkspace();
  const { events, reconnecting } = useRunStream(run, onUpdate);
  return <div className="live-run">{showPrompt && <div className="message message-user"><div className="message-author"><span className="avatar user-avatar">Y</span><strong>You</strong></div><div className="user-content">{run.prompt}</div></div>}
    <div className="message message-assistant"><div className="message-author"><span className="avatar agent-avatar"><span>✳</span></span><strong>{agent?.name || 'Agent'}</strong><RunBadge status={run.status} /><button className="message-details" onClick={() => inspectRun(run)}>Details <ArrowRight size={12} /></button></div>
      <ToolEvents events={events} />{showResponse && (run.response ? <Markdown>{run.response}</Markdown> : !isTerminal(run.status) && run.status !== 'interrupted' ? <div className="thinking"><span /><span /><span /><span className="sr-only">The agent is working.</span></div> : null)}
      {reconnecting && !isTerminal(run.status) && <span className="stream-reconnect"><RefreshCw size={12} />Reconnecting to live updates. Your run remains on the server.</span>}
      <RunControls run={run} onUpdate={onUpdate} />
    </div>
  </div>;
}
export function RunInspector({ initial, onClose }: { initial: Run; onClose: () => void }) {
  const { preferences, navigate, agent } = useWorkspace();
  const [run, setRun] = useState(initial);
  const { events, reconnecting } = useRunStream(run, setRun);
  useEffect(() => { setRun(initial); }, [initial.id]);
  return <Modal title="Run details" wide onClose={onClose}><div className="modal-body run-inspector"><div className="inspector-status"><RunBadge status={run.status} />{reconnecting && !isTerminal(run.status) && <span>Reconnecting…</span>}<span className="mono">{run.id}</span></div><dl className="detail-grid"><div><dt>Started</dt><dd>{dateTime(run.createdAt, preferences.timezone)}</dd></div><div><dt>Last update</dt><dd>{dateTime(run.updatedAt, preferences.timezone)}</dd></div>{run.providerRunId && <div><dt>Provider run</dt><dd className="mono wrap-anywhere">{run.providerRunId}</dd></div>}</dl><div className="inspector-section"><h3>Request</h3><p className="preserve-space">{run.prompt}</p></div><ToolEvents events={events} />{run.response && <div className="inspector-section"><h3>Response</h3><Markdown>{run.response}</Markdown></div>}<RunControls run={run} onUpdate={setRun} /><p className="inspector-note"><Clock3 size={14} />Run history is stored by this workspace. Closing this view leaves the work running.</p></div><div className="modal-footer"><Button onClick={onClose}>Close</Button>{agent?.id === run.agentId && <Button variant="primary" onClick={() => { onClose(); navigate('chat', run.conversationId); }}>Open conversation <ArrowRight size={15} /></Button>}</div></Modal>;
}
