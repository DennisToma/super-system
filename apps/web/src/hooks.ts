import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page, Run, RunEvent } from '@super-system/core';
import { isTerminal } from '@super-system/core';
import { api, errorMessage, segment } from './api';

export function useResource<T>(path: string | null, initial?: T) {
  const [data, setData] = useState<T | undefined>(initial);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const previousPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    if (previousPath.current !== path) { setData(undefined); previousPath.current = path; }
    if (!path) { setLoading(false); setError(undefined); return; }
    setLoading(true);
    setError(undefined);
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision]);
  return { data, loading, error, refresh, setData };
}

export function usePaged<T extends { id: string }>(path: string | null) {
  const first = useResource<Page<T>>(path);
  const [extra, setExtra] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loadedMore, setLoadedMore] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => { generation.current++; setExtra([]); setCursor(undefined); setLoadedMore(false); setMoreLoading(false); setMoreError(undefined); }, [path, first.data]);
  const nextCursor = loadedMore ? cursor : first.data?.nextCursor;
  const loadMore = async () => {
    if (!path || !nextCursor || moreLoading) return;
    const current = generation.current;
    setMoreLoading(true); setMoreError(undefined);
    try {
      const next = await api<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}cursor=${segment(nextCursor)}`);
      if (generation.current !== current) return;
      setExtra(value => [...value, ...next.items]); setCursor(next.nextCursor); setLoadedMore(true);
    } catch (cause) { if (generation.current === current) setMoreError(errorMessage(cause)); }
    finally { if (generation.current === current) setMoreLoading(false); }
  };
  const items = [...new Map([...(first.data?.items || []), ...extra].map(item => [item.id, item])).values()];
  return { ...first, items, nextCursor, loadMore, moreLoading, moreError };
}

// Events trigger reads of the durable snapshot. Replaying text never appends it twice.
export function useRunStream(run: Run, onUpdate: (value: Run) => void) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  useEffect(() => {
    let disposed = false;
    let highestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let refreshing = false;
    let dirty = false;
    setEvents([]);
    const refresh = async () => {
      if (disposed) return;
      if (refreshing) { dirty = true; return; }
      refreshing = true;
      try {
        const value = await api<Run>(`/runs/${segment(run.id)}`);
        if (!disposed) {
          updateRef.current(value);
          if (isTerminal(value.status) || value.releasedAt) { if (poll) clearInterval(poll); setReconnecting(false); }
        }
      }
      catch { /* EventSource reconnect and polling recover transient reads. */ }
      finally { refreshing = false; if (dirty && !disposed) { dirty = false; void refresh(); } }
    };
    const source = new EventSource(`/api/runs/${segment(run.id)}/events?after=0`);
    source.onopen = () => { setReconnecting(false); void refresh(); };
    source.onerror = () => setReconnecting(true);
    source.addEventListener('run', event => {
      try {
        const item = JSON.parse((event as MessageEvent).data) as RunEvent;
        if (item.runId !== run.id || item.sequence <= highestSequence) return;
        highestSequence = item.sequence;
        // Keep structured events for inspection. Text lives in the server snapshot.
        if (item.payload.type !== 'text') setEvents(values => [...values.slice(-199), item]);
        if (item.payload.type === 'status' && isTerminal(item.payload.status)) { if (timer) clearTimeout(timer); if (poll) clearInterval(poll); void refresh(); source.close(); setReconnecting(false); }
        else if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 120);
      } catch { /* Ignore malformed events; the persisted snapshot remains authoritative. */ }
    });
    if (!isTerminal(run.status) && !run.releasedAt) poll = setInterval(() => { void refresh(); }, 2500);
    return () => { disposed = true; source.close(); if (poll) clearInterval(poll); if (timer) clearTimeout(timer); };
  }, [run.id]);
  return { events, reconnecting };
}

export function useDebounced<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}
