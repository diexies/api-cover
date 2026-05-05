import { useEffect, useRef } from 'react';

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  header?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Lightweight in-app right-click menu. Closes on outside click, Escape, or any item action.
 * Positioned with fixed coords; clamps to viewport so it never opens off-screen.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport on first render so menus near right/bottom edges don't overflow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(0, r.right - window.innerWidth + 8);
    const dy = Math.max(0, r.bottom - window.innerHeight + 8);
    if (dx || dy) el.style.transform = `translate(${-dx}px, ${-dy}px)`;
  }, []);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="ctx-menu-sep" />;
        if (it.header) return <div key={i} className="ctx-menu-header">{it.label}</div>;
        const cls = ['ctx-menu-item'];
        if (it.danger) cls.push('danger');
        if (it.disabled) cls.push('disabled');
        return (
          <div
            key={i}
            className={cls.join(' ')}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </div>
        );
      })}
    </div>
  );
}
