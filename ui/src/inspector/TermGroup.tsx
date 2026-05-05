import { useState, type ReactNode } from 'react';

export type GroupAccent =
  | 'phosphor'
  | 'cyan'
  | 'violet'
  | 'amber'
  | 'magenta'
  | 'dim';

interface Props {
  /** Glyph + label e.g. "$ body" or "> headers" — keep the prompt prefix in the title. */
  title: string;
  accent: GroupAccent;
  defaultOpen?: boolean;
  badge?: number;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}

/**
 * Collapsible group inside a tab pane. Each accent variant carries a distinct color identity:
 * users can scan the column and see what concern lives where without reading labels. When open
 * the body gets a subtle accent-tinted background and inset padding for depth; the rail stays
 * a fixed 2px on the left edge.
 */
export function TermGroup({ title, accent, defaultOpen = false, badge, hint, action, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`term-group term-group-${accent} ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="term-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="term-group-rail" aria-hidden />
        <span className="term-caret">{open ? '▾' : '▸'}</span>
        <span className="term-group-title">{title}</span>
        {badge != null && badge > 0 && (
          <span className="term-group-badge">{badge}</span>
        )}
        {hint && <span className="term-group-hint">{hint}</span>}
        {action && (
          <span className="term-group-action" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
      </button>
      <div className="term-group-body-wrap">
        {open && <div className="term-group-body">{children}</div>}
      </div>
    </div>
  );
}
