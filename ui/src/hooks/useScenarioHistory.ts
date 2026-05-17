import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiNode, Breakpoint, CaseSet, ExecutionGroup } from '../api';

/** Snapshot of every scenario-shape field. RF visual state is derived; not captured. */
export interface ScenarioSnapshot {
  apiNodes: ApiNode[];
  breakpoints: Breakpoint[];
  startNodeIds: string[];
  groups: ExecutionGroup[];
  caseSets: CaseSet[];
  flowName: string;
  flowDescription: string;
  flowTags: string[];
}

export interface UseScenarioHistoryArgs {
  /** Live snapshot — read on every render; pushed to the stack when it diverges. */
  current: ScenarioSnapshot;
  /** Apply a snapshot back to live state. Called on undo / redo. */
  apply: (snap: ScenarioSnapshot) => void;
  /** Debounce in ms — rapid edits coalesce into one undo step. */
  debounceMs?: number;
  /** Max stack depth. Older snapshots evict from the bottom. */
  maxDepth?: number;
}

export interface UseScenarioHistoryReturn {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Drop the entire stack — call on scenario swap. */
  reset: (initial: ScenarioSnapshot) => void;
}

function snapshotsEqual(a: ScenarioSnapshot, b: ScenarioSnapshot): boolean {
  // Deep-equal by JSON serialisation. Cheap enough for typical scenario sizes (~10kb).
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Linear undo/redo history for the scenario shape. Pushes a snapshot when the current
 * value diverges from the top of the stack, debounced so rapid keystrokes coalesce.
 *
 * Undo/redo applies the snapshot via the caller's `apply` fn. Suppresses self-triggered
 * snapshot pushes via an internal flag so undo doesn't immediately re-push the prior state.
 */
export function useScenarioHistory({
  current,
  apply,
  debounceMs = 400,
  maxDepth = 50,
}: UseScenarioHistoryArgs): UseScenarioHistoryReturn {
  const stackRef = useRef<ScenarioSnapshot[]>([current]);
  const [index, setIndex] = useState(0);
  const indexRef = useRef<number>(0);
  indexRef.current = index;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Snapshot just installed by undo/redo. Pending effect pushes that match this should
   *  be skipped so the apply() callback doesn't immediately re-push the same value. */
  const lastAppliedRef = useRef<ScenarioSnapshot | null>(null);

  // Watch current; push when stable + diverged from top.
  useEffect(() => {
    if (lastAppliedRef.current && snapshotsEqual(lastAppliedRef.current, current)) {
      // Current matches the snapshot just applied by undo/redo — skip the push that
      // would otherwise re-record it.
      lastAppliedRef.current = null;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const top = stackRef.current[indexRef.current];
      if (top && snapshotsEqual(top, current)) return;
      // Truncate redo tail when pushing a new branch.
      const truncated = stackRef.current.slice(0, indexRef.current + 1);
      truncated.push(current);
      while (truncated.length > maxDepth) truncated.shift();
      stackRef.current = truncated;
      setIndex(truncated.length - 1);
    }, debounceMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [current, debounceMs, maxDepth]);

  const undo = useCallback(() => {
    if (indexRef.current <= 0) return;
    const next = indexRef.current - 1;
    const snap = stackRef.current[next];
    lastAppliedRef.current = snap;
    apply(snap);
    setIndex(next);
  }, [apply]);

  const redo = useCallback(() => {
    if (indexRef.current >= stackRef.current.length - 1) return;
    const next = indexRef.current + 1;
    const snap = stackRef.current[next];
    lastAppliedRef.current = snap;
    apply(snap);
    setIndex(next);
  }, [apply]);

  const reset = useCallback((initial: ScenarioSnapshot) => {
    stackRef.current = [initial];
    setIndex(0);
  }, []);

  return {
    canUndo: index > 0,
    canRedo: index < stackRef.current.length - 1,
    undo,
    redo,
    reset,
  };
}
