import { useState } from 'react';
import { usePrefs } from './stores/prefs';

/**
 * Tracks a column width persisted via the central prefs store. The caller wires
 * <c>startResize</c> to a handle's <c>onMouseDown</c>; the hook attaches global
 * mousemove/mouseup listeners for the lifetime of the drag, computes a new width clamped
 * to <c>[min, max]</c>, and writes it back. <c>edge</c> describes which side the handle
 * lives on so a leftward drag widens or narrows the right column, depending on placement.
 */
export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number
): { width: number; startResize: (e: React.MouseEvent, edge: 'left' | 'right') => void } {
  // Subscribe with shallow selector so unrelated width changes don't re-render this caller.
  const stored = usePrefs((s) => s.widths[storageKey]);
  const setWidthInStore = usePrefs((s) => s.setWidth);
  const initial = Number.isFinite(stored) ? Math.min(max, Math.max(min, stored)) : defaultWidth;
  const [width, setWidth] = useState<number>(initial);

  function persist(next: number) {
    setWidth(next);
    setWidthInStore(storageKey, next);
  }

  function startResize(e: React.MouseEvent, edge: 'left' | 'right') {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      // Right-edge handle (e.g. left sidebar): drag right widens.
      // Left-edge handle (e.g. right inspector): drag left widens.
      const next = edge === 'right' ? startW + dx : startW - dx;
      last = Math.min(max, Math.max(min, next));
      setWidth(last);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Persist only at the end of the drag so we don't write 60× per second to the store.
      persist(last);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  return { width, startResize };
}
