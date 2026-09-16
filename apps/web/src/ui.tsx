import { cloneElement, isValidElement, useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronRight, LoaderCircle, Search, X, type LucideIcon } from 'lucide-react';
import type { Capability, RunStatus } from '@super-system/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Button({ children, className = '', variant = 'secondary', busy = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button className={`button button-${variant} ${className}`} {...props} disabled={props.disabled || busy}>{busy && <LoaderCircle size={15} className="spin" />}{children}</button>;
}
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className="icon-button" type="button" title={label} aria-label={label} {...props}>{children}</button>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  return <span className={`badge badge-${tone}`}><span className="badge-dot" />{children}</span>;
}
export const statusLabel = (status: string) => ({ waiting_for_approval: 'Needs approval', interrupted: 'Needs review', cancelling: 'Stopping' }[status] || status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' '));
export function RunBadge({ status }: { status: RunStatus }) {
  return <Badge tone={status === 'completed' ? 'good' : ['waiting_for_approval', 'interrupted'].includes(status) ? 'warn' : status === 'failed' ? 'bad' : 'neutral'}>{statusLabel(status)}</Badge>;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="header-actions">{actions}</div>}</header>;
}
export function EmptyState({ icon: Icon, title, children, action, compact }: { icon: LucideIcon; title: string; children: ReactNode; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'empty-compact' : ''}`}><div className="empty-icon"><Icon size={25} strokeWidth={1.5} /></div><h3>{title}</h3><div className="empty-description">{children}</div>{action && <div className="empty-action">{action}</div>}</div>;
}
export function CapabilityNotice({ capability, title, icon }: { capability: Capability; title: string; icon: LucideIcon }) {
  return <EmptyState icon={icon} title={title}><p>{capability.reason || (capability.state === 'unsupported' ? 'This feature is not supported by the connected Letta server.' : 'Connect your Letta server to use this part of your workspace.')}</p><span className="quiet-label">{capability.state === 'unsupported' ? 'Not supported by this connection' : 'Waiting for a connection'}</span></EmptyState>;
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-notice" role="alert"><AlertCircle size={17} /><span>{message}</span>{retry && <Button variant="ghost" onClick={retry}>Try again <ArrowRight size={14} /></Button>}</div>;
}
export function Loading({ label = 'Loading workspace…' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle size={20} className="spin" /><span>{label}</span></div>;
}
export function SearchField({ value, onChange, placeholder = 'Search', label = placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string }) {
  return <div className="search-field"><Search size={16} /><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} />{value && <IconButton label="Clear search" onClick={() => onChange('')}><X size={14} /></IconButton>}</div>;
}
export function LoadMore({ available, loading, onClick }: { available: boolean; loading?: boolean; onClick: () => void }) {
  return available ? <div className="load-more"><Button busy={loading} onClick={onClick}>Load more <ChevronRight size={14} /></Button></div> : null;
}
export function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{children}</ReactMarkdown></div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.querySelector<HTMLElement>('button, input, textarea, select, [tabindex="0"]')?.focus();
    const listener = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) !== root.current) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const focusables = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || [])].filter(item => item.getClientRects().length);
        const first = focusables[0], last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={root} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton></div>{children}</div></div>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const control = isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-labelledby': `${id}-label`, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : children;
  return <label className="field"><span id={`${id}-label`}>{label}</span>{control}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function dateTime(value?: string, timezone?: string) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(date);
}
export function relativeTime(value: string) {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <button ref={ref} className="button button-ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); if (ref.current) ref.current.textContent = 'Copied'; } catch { if (ref.current) ref.current.textContent = 'Copy unavailable'; } }}><Check size={14} />{label}</button>;
}
