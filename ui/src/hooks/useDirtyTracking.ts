import { useEffect, useRef, useState } from 'react';

export interface UseDirtyTrackingArgs {
  /** Disable autosave while the run engine is writing ephemeral state. */
  running: boolean;
  /** Last save error — bumps the debounce to 5s to back off a downed host. */
  err: string | null;
  /** Called after the debounce fires (and on demand via the returned saveRef). */
  save: () => Promise<void>;
  /** Snapshot of every observable scenario field — any change re-arms the debounce. */
  watch: ReadonlyArray<unknown>;
}

export interface UseDirtyTrackingReturn {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  setDirty: (v: boolean) => void;
  setSaving: (v: boolean) => void;
  setLastSavedAt: (v: number | null) => void;
  /** Synchronously-current dirty flag — read from cleanup effects without re-rendering. */
  dirtyRef: React.MutableRefObject<boolean>;
  /** Latest save closure, refreshed every render — used by scenario-swap force-save. */
  saveRef: React.MutableRefObject<() => Promise<void>>;
}

/**
 * Tracks the dirty/saving/lastSavedAt triple and owns the debounced auto-save. Guards
 * against unsaved-data loss via a beforeunload listener.
 *
 * Behavioural contract preserved verbatim from the original inline implementation:
 * - Autosave fires 800ms after the last edit (5000ms when the previous attempt errored).
 * - Cleanup cancels a pending fire if a new edit lands within the window.
 * - Autosave is skipped while `running` (engine owns state) or `saving` (overlap).
 * - The post-save dirty flip re-arms the debounce when needed.
 * - The `react-hooks/exhaustive-deps` rule is disabled on the autosave effect: callers
 *   pass the dep snapshot via `watch` so the autosave fires for every observable change
 *   without forcing the hook to know what those fields are.
 * - `dirtyRef` mirrors `dirty` synchronously so cleanup effects can read it without
 *   subscribing to renders.
 * - `saveRef.current = save` runs every render (no-dep useEffect) so the scenario-swap
 *   force-save sees the latest closure.
 */
export function useDirtyTracking(args: UseDirtyTrackingArgs): UseDirtyTrackingReturn {
  const { running, err, save, watch } = args;
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const saveRef = useRef<() => Promise<void>>(save);
  // Refresh on every render so the most recent closure is available — matches the original
  // L963 "useEffect(() => { onSaveRef.current = onSave; })" with no deps.
  useEffect(() => { saveRef.current = save; });

  // Tab-close guard. Browsers ignore custom text — a non-empty returnValue is enough to
  // trigger the native prompt. No-op when the canvas is clean.
  useEffect(() => {
    if (!dirty && !saving) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, saving]);

  // Debounced auto-save. Re-armed by every watch-tuple change; cleanup cancels a pending
  // fire if a new edit lands within the window.
  useEffect(() => {
    if (!dirty || running || saving) return;
    const delay = err ? 5000 : 800;
    const t = setTimeout(() => { void save(); }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, running, saving, err, ...watch]);

  return {
    dirty,
    saving,
    lastSavedAt,
    setDirty,
    setSaving,
    setLastSavedAt,
    dirtyRef,
    saveRef,
  };
}
