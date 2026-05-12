import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteCommand {
  /** Stable identifier — used as the React key. */
  id: string;
  /** Visible label (case-insensitive substring match against the query). */
  label: string;
  /** Optional secondary line — endpoint count, scenario description, etc. */
  hint?: string;
  /** Optional category shown in the right gutter (e.g. "scenario", "settings"). */
  group?: string;
  /** Shortcut hint shown right-aligned. Decorative only. */
  shortcut?: string;
  /** Action to invoke when selected. The palette closes automatically afterward. */
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
}

/**
 * Global command palette. Cmd/Ctrl+K toggles it; Escape closes; arrow keys + Enter
 * navigate. Filter is case-insensitive substring match against label + hint + group.
 *
 * Mount once at the app root; the palette is self-contained — it does not need any
 * external state besides the command list.
 */
export function CommandPalette({ commands }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global Cmd+K / Ctrl+K toggles. Bind once.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Refocus the input every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      // Defer to next paint so the input exists in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const blob = `${c.label} ${c.hint ?? ''} ${c.group ?? ''}`.toLowerCase();
      return blob.includes(q);
    });
  }, [commands, query]);

  // Reset highlight whenever the filtered set changes so we don't point at a missing index.
  useEffect(() => {
    setActiveIdx((cur) => (cur >= filtered.length ? 0 : cur));
  }, [filtered.length]);

  if (!open) return null;

  function close() { setOpen(false); }
  function runAt(i: number) {
    const cmd = filtered[i];
    if (!cmd) return;
    cmd.run();
    close();
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(activeIdx);
    }
  }

  return (
    <div className="cmdk-backdrop" onMouseDown={close} role="dialog" aria-modal="true" aria-label="command palette">
      <div className="cmdk-shell" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          aria-label="search commands"
        />
        <ul className="cmdk-list" role="listbox">
          {filtered.length === 0 && (
            <li className="cmdk-empty">No commands match “{query}”.</li>
          )}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === activeIdx}
              className={`cmdk-item ${i === activeIdx ? 'is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); runAt(i); }}
            >
              <span className="cmdk-item-label">{c.label}</span>
              {c.hint && <span className="cmdk-item-hint">{c.hint}</span>}
              {c.group && <span className="cmdk-item-group">{c.group}</span>}
              {c.shortcut && <kbd className="cmdk-item-shortcut">{c.shortcut}</kbd>}
            </li>
          ))}
        </ul>
        <div className="cmdk-footer" aria-hidden="true">
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> run <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
