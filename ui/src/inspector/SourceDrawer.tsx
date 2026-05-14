import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { getSource, type SourceSlice } from '../api';
import Prism from 'prismjs';
import 'prismjs/components/prism-csharp';
import { MethodFlowchart } from './MethodFlowchart';
import { ServiceCallersList } from './ServiceCallersList';

export interface MethodIndexEntry {
  id: string;
  path?: string;
  line?: number;
  endLine?: number;
  methodName?: string;
}

interface Props {
  nodeId: string;
  path?: string;
  line?: number;
  endLine?: number;
  /** Plain method name (no params). When present, the Callers tab fetches the
   * method-granular reverse index instead of the whole-service rollup so the LLM/user
   * sees only call sites that hit this exact method. */
  methodName?: string;
  /** Method-name → location map so the drawer can wire `_x.MethodName(` mentions into
   * click-through jumps without re-fetching the call graph. */
  methodIndex?: Map<string, MethodIndexEntry>;
  /** Open another method's drawer in-place (the parent replaces the current open state). */
  onJumpTo?: (target: MethodIndexEntry) => void;
  /** Navigation: pop the navigation stack one step back to the prior method. */
  canGoBack?: boolean;
  onBack?: () => void;
  onClose: () => void;
}

/**
 * Right-click → "View source" overlay. Fetches a window around the PDB-resolved line so the
 * user can read the actual method body instead of guessing what a service node does. Shows
 * "no source" gracefully when the walker had no file info.
 *
 * When the caller passes both `line` and `endLine` (method body range from the call graph),
 * the drawer scrolls the start line into view, highlights the method range, and dims the rest
 * of the file so the eye lands on the relevant method instantly.
 */
type ViewMode = 'source' | 'diagram' | 'callers';
const VIEW_KEY = 'apicover.sourceDrawerView';

function SourceDrawerImpl({ nodeId, path, line, endLine, methodName, methodIndex, onJumpTo, canGoBack, onBack, onClose }: Props) {
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  // Service nodes use a dotted FQTN id; endpoints look like "METHOD /path". Only services
  // expose a meaningful reverse-fan-in caller list, so we gate the Callers tab on that shape.
  const isService = !nodeId.includes(' /') && nodeId.includes('.');
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const v = window.localStorage?.getItem(VIEW_KEY);
      if (v === 'diagram') return 'diagram';
      if (v === 'callers' && isService) return 'callers';
      return 'source';
    } catch { return 'source'; }
  });

  function pickView(v: ViewMode) {
    setView(v);
    try { window.localStorage?.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!path) { setSlice(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSlice(null);
    (async () => {
      try {
        const s = await getSource(path, line, endLine);
        if (!cancelled) setSlice(s);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, line, endLine]);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      // Alt+Left (Mac: Cmd is browser-native, but inside our drawer we own the keymap).
      if (e.key === 'ArrowLeft' && (e.altKey || e.metaKey)) {
        if (canGoBack && onBack) { e.preventDefault(); onBack(); }
      }
    };
    // Mouse back button (button=3 on most pointing devices). Captured on the drawer aside via
    // onAuxClick handler below; this listener handles cases where the focus is elsewhere.
    const mouseHandler = (e: MouseEvent) => {
      if (e.button === 3) {
        if (canGoBack && onBack) { e.preventDefault(); onBack(); }
      }
    };
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('mouseup', mouseHandler);
    return () => {
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('mouseup', mouseHandler);
    };
  }, [onClose, canGoBack, onBack]);

  // After the highlighted slice mounts (or replaces — jump-to case), scroll the focus line
  // into view inside the drawer's body container. rAF lets the new pre element mount its
  // children before we measure offsetTop.
  useEffect(() => {
    if (!slice) return;
    const raf = requestAnimationFrame(() => {
      const el = focusRef.current;
      if (!el) return;
      // Walk up to the scrollable body container so we scroll the drawer pane, not the page.
      let parent: HTMLElement | null = el.parentElement;
      while (parent && !parent.classList.contains('source-drawer-body')) parent = parent.parentElement;
      if (!parent) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }
      const top = el.offsetTop - parent.clientHeight / 2 + el.clientHeight / 2;
      parent.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    });
    return () => cancelAnimationFrame(raf);
  }, [slice]);

  const highlightedLines = useMemo(() => {
    if (!slice) return [] as string[];
    const lang = slice.language === 'cs' ? 'csharp' : (slice.language || 'csharp');
    const grammar = (Prism.languages as Record<string, Prism.Grammar | undefined>)[lang] ?? Prism.languages.csharp;
    if (!grammar) return slice.lines;
    return slice.lines.map((ln) => Prism.highlight(ln, grammar, lang));
  }, [slice]);

  // Collect method-call jump targets that appear inside the method body. We scan the raw
  // slice (not the highlighted HTML) so token regex stays out of the way. Matching is
  // best-effort: any identifier followed by `(` whose name exists in methodIndex.
  const jumpTargets = useMemo(() => {
    if (!slice || !methodIndex || methodIndex.size === 0) return [] as MethodIndexEntry[];
    const inMethodStart = (slice.methodStart ?? line) ?? slice.startLine;
    const inMethodEnd = (slice.methodEnd ?? endLine) ?? slice.endLine;
    const seen = new Set<string>();
    const out: MethodIndexEntry[] = [];
    const idRegex = /\b([A-Z][A-Za-z0-9_]+)\s*\(/g;
    slice.lines.forEach((ln, i) => {
      const lineNo = slice.startLine + i;
      if (lineNo < inMethodStart || lineNo > inMethodEnd) return;
      let m: RegExpExecArray | null;
      while ((m = idRegex.exec(ln)) !== null) {
        const name = m[1];
        if (seen.has(name)) continue;
        const target = methodIndex.get(name);
        if (!target) continue;
        if (target.id === nodeId) continue; // don't link self
        seen.add(name);
        out.push(target);
      }
    });
    return out;
  }, [slice, methodIndex, nodeId, line, endLine]);

  const fileName = path?.split('/').pop() ?? nodeId;
  // PDB sequence points start at the first executable statement which is usually the opening
  // `{` (one line below the method signature). Widen the bright range up by one so the user
  // sees the method declaration in colour too, not dim.
  const pdbStart = slice?.methodStart ?? line;
  const methodEnd = slice?.methodEnd ?? endLine ?? pdbStart;
  const methodStart = pdbStart != null ? Math.max(1, pdbStart - 1) : pdbStart;

  return (
    <>
      <div className="source-drawer-backdrop" onClick={onClose} />
      <aside className="source-drawer" role="dialog" aria-modal="true" aria-label={`Source for ${nodeId}`}>
        <header className="source-drawer-head">
          <button
            type="button"
            className="source-drawer-back"
            onClick={() => onBack?.()}
            disabled={!canGoBack}
            aria-label="Back to previous source view"
            title={canGoBack ? 'Back (Alt+Left / mouse back)' : 'No previous view'}
          >←</button>
          <div className="source-drawer-title">
            <strong>{fileName}</strong>
            {methodStart && methodEnd && methodEnd > methodStart ? (
              <span className="muted small">{` :${methodStart}-${methodEnd}`}</span>
            ) : methodStart ? (
              <span className="muted small">{` :${methodStart}`}</span>
            ) : null}
          </div>
          <div className="source-drawer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'source'}
              className={`source-drawer-tab${view === 'source' ? ' is-active' : ''}`}
              onClick={() => pickView('source')}
            >Source</button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'diagram'}
              className={`source-drawer-tab${view === 'diagram' ? ' is-active' : ''}`}
              onClick={() => pickView('diagram')}
            >Diagram</button>
            {isService && (
              <button
                type="button"
                role="tab"
                aria-selected={view === 'callers'}
                className={`source-drawer-tab${view === 'callers' ? ' is-active' : ''}`}
                onClick={() => pickView('callers')}
              >Callers</button>
            )}
          </div>
          <button type="button" className="source-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {!path && (
          <div className="source-drawer-empty">
            <p className="muted">No source location available for this node.</p>
            <p className="muted small">
              Interface stubs, framework calls, and dynamic dispatch don't expose a file path.
            </p>
          </div>
        )}
        {loading && <div className="source-drawer-empty muted">Loading…</div>}
        {err && <div className="source-drawer-empty error">{err}</div>}
        {slice && jumpTargets.length > 0 && onJumpTo && (
          <div className="source-drawer-jumps" aria-label="method calls in this body">
            <span className="muted small">Jump to:</span>
            {jumpTargets.slice(0, 8).map((t) => {
              const last = t.id.lastIndexOf('.');
              const name = last >= 0 ? t.id.substring(last + 1) : t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className="source-drawer-jump"
                  onClick={() => onJumpTo(t)}
                  title={t.id}
                >{name}</button>
              );
            })}
          </div>
        )}
        {slice && view === 'source' && (
          <div className="source-drawer-body">
            <div className="source-drawer-path muted small">{slice.path}</div>
            <pre
              className="source-drawer-pre language-csharp"
              onClick={(e) => {
                if (!methodIndex || !onJumpTo) return;
                const t = e.target as HTMLElement;
                if (!t || !t.classList) return;
                // Prism marks call-target identifiers with `.token.function`. We accept that
                // plus generic class-name tokens since some C# method names are tokenized
                // as class-name when followed by `<` (generic dispatch).
                if (!t.classList.contains('token')) return;
                if (!t.classList.contains('function') && !t.classList.contains('class-name')) return;
                const name = (t.textContent || '').trim();
                if (!name) return;
                const target = methodIndex.get(name);
                if (!target || target.id === nodeId) return;
                e.stopPropagation();
                onJumpTo(target);
              }}
            >
              {slice.lines.map((ln, i) => {
                const lineNo = slice.startLine + i;
                const inMethod = methodStart != null && methodEnd != null
                  ? lineNo >= methodStart && lineNo <= methodEnd
                  : false;
                // Place the scroll anchor + accent border on the method signature line
                // (or whatever methodStart resolves to after the -1 widen).
                const isStart = methodStart === lineNo;
                return (
                  <div
                    key={lineNo}
                    ref={isStart ? focusRef : undefined}
                    className={`source-line${inMethod ? ' is-in-method' : ' is-dim'}${isStart ? ' is-method-start' : ''}`}
                  >
                    <span className="source-line-num">{lineNo}</span>
                    <code
                      className="source-line-text"
                      dangerouslySetInnerHTML={{ __html: highlightedLines[i] || (ln || ' ') }}
                    />
                  </div>
                );
              })}
            </pre>
          </div>
        )}
        {slice && view === 'diagram' && path && pdbStart != null && (
          <div className="source-drawer-body source-drawer-diagram-full">
            <MethodFlowchart path={path} line={pdbStart} />
          </div>
        )}
        {slice && view === 'diagram' && (!path || pdbStart == null) && (
          <div className="source-drawer-empty muted">Diagram unavailable — no method source mapping for this node.</div>
        )}
        {view === 'callers' && isService && (
          <div className="source-drawer-body source-drawer-callers-full">
            <ServiceCallersList
              serviceId={nodeId}
              methodName={methodName}
              onPickSource={(filePath, ln, endLn) => {
                pickView('source');
                if (onJumpTo) onJumpTo({ id: nodeId, path: filePath, line: ln, endLine: endLn });
              }}
            />
          </div>
        )}
      </aside>
    </>
  );
}

export const SourceDrawer = memo(SourceDrawerImpl);
