import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  branchKey,
  getRun,
  startRun,
  subscribeRunEvents,
  type NodeResult,
  type Run,
  type RunEvent,
  type SseStatus,
} from '../api';
import { authToRunOptions, type AuthConfig } from '../auth';

export interface UseRunExecutionArgs {
  scenarioId: string;
  auth: AuthConfig;
  /** Called before start() actually starts a run. Lets the dirty-tracking layer flush
   *  pending edits synchronously so the engine sees the latest scenario state. */
  forceSaveIfDirty: () => Promise<void>;
  /** Surface human-readable errors back to the parent for banner display. */
  onError: (msg: string) => void;
}

export interface UseRunExecutionReturn {
  run: Run | null;
  setRun: Dispatch<SetStateAction<Run | null>>;
  running: boolean;
  historyTick: number;
  sseStatus: SseStatus | null;
  start: () => Promise<void>;
  resolveBreakpoint: (action: 'resume' | 'skip' | 'abort') => Promise<void>;
  /** Drops the SSE subscription cleanly. Called by the scenario-swap reset. */
  reset: () => void;
}

/**
 * Owns the run lifecycle: start a run, subscribe to SSE events, react to terminal
 * statuses, expose breakpoint resolution. Keeps `unsubRef` private so subscription
 * leaks across scenario swaps are impossible.
 */
export function useRunExecution({
  scenarioId,
  auth,
  forceSaveIfDirty,
  onError,
}: UseRunExecutionArgs): UseRunExecutionReturn {
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  // Bumped whenever a run reaches a terminal state so RunHistoryPanel refetches.
  const [historyTick, setHistoryTick] = useState(0);
  const [sseStatus, setSseStatus] = useState<SseStatus | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setRun(null);
    setRunning(false);
    setSseStatus(null);
  }, []);

  // Component unmount → drop subscription.
  useEffect(() => () => { unsubRef.current?.(); unsubRef.current = null; }, []);

  const handleEvent = useCallback((evt: RunEvent) => {
    if (evt.type === 'snapshot') {
      const snapshot = evt.payload as Run;
      setRun(snapshot);
      if (snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        setRunning(false);
        setHistoryTick((t) => t + 1);
      }
      return;
    }
    if (evt.type === 'runStarted') { setRun(evt.payload as Run); return; }
    if (evt.type === 'runFinished') {
      setRun(evt.payload as Run); setRunning(false);
      unsubRef.current?.(); unsubRef.current = null;
      setHistoryTick((t) => t + 1);
      return;
    }
    const result = evt.payload as NodeResult | undefined;
    if (!result || !evt.nodeId) return;
    const evtKey = (evt.branchPath ?? []).join('/');
    setRun((prev) => {
      if (!prev) return prev;
      // Upsert by (nodeId, branchKey). Newly forked branches just append.
      const others = prev.nodeResults.filter(
        (r) => !(r.nodeId === evt.nodeId && branchKey(r) === evtKey),
      );
      return {
        ...prev,
        nodeResults: [...others, result],
        status: evt.type === 'nodePaused' ? 'paused' : prev.status,
        pausedAtNodeId: evt.type === 'nodePaused' ? evt.nodeId
          : (evt.type === 'nodeResumed' ? undefined : prev.pausedAtNodeId),
      };
    });
  }, []);

  const start = useCallback(async () => {
    // Force-save flushes any pending 800ms-debounced edit before the engine reads the scenario.
    try { await forceSaveIfDirty(); } catch { return; }
    setRunning(true);
    try {
      const authOpts = authToRunOptions(auth);
      const started = await startRun(scenarioId, {
        breakpointsEnabled: true,
        headers: authOpts.headers,
        queryParameters: authOpts.queryParameters,
      });
      setRun(started);
      unsubRef.current?.();
      unsubRef.current = subscribeRunEvents(started.id, handleEvent, {
        onError: () => { getRun(started.id).then(setRun).catch(() => {}); },
        onStatus: (s) => setSseStatus(s),
      });
    } catch (e) {
      onError((e as Error).message);
      setRunning(false);
    }
  }, [scenarioId, auth, forceSaveIfDirty, onError, handleEvent]);

  const resolveBreakpoint = useCallback(async (action: 'resume' | 'skip' | 'abort') => {
    if (!run?.pausedAtNodeId) return;
    try {
      const r = await fetch(
        `/apicover/api/runs/${encodeURIComponent(run.id)}/breakpoints/${encodeURIComponent(run.pausedAtNodeId)}/resolve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [run, onError]);

  return { run, setRun, running, historyTick, sseStatus, start, resolveBreakpoint, reset };
}
