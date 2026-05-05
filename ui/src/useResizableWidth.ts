import { useEffect, useState } from 'react';

/**
 * Tracks a column width persisted to localStorage. The caller wires <c>startResize</c> to a
 * handle's <c>onMouseDown</c>; the hook attaches global mousemove/mouseup listeners for the
 * lifetime of the drag, computes a new width clamped to <c>[min, max]</c>, and writes it
 * back. <c>edge</c> describes which side the handle lives on so a leftward drag widens or
 * narrows the right column, depending on placement.
 */
export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number
): { width: number; startResize: (e: React.MouseEvent, edge: 'left' | 'right') => void } {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const raw = window.localStorage.getItem(storageKey);
    const v = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : defaultWidth;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  function startResize(e: React.MouseEvent, edge: 'left' | 'right') {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      // Right-edge handle (e.g. left sidebar): drag right widens.
      // Left-edge handle (e.g. right inspector): drag left widens.
      const next = edge === 'right' ? startW + dx : startW - dx;
      setWidth(Math.min(max, Math.max(min, next)));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  return { width, startResize };
}
