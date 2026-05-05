import { useEffect, useState } from 'react';
import { getCallGraph, rebuildCallGraphs, type CallGraphDto, type CallNodeDto, type CallNodeKind } from '../api';

interface Props {
  /** Endpoint id matching <c>EndpointDescriptor.Id</c> (e.g. "GET /users/{id}"). */
  endpointId?: string;
}

const KIND_BADGE: Record<CallNodeKind, string> = {
  controllerMethod: 'controller',
  method: 'method',
  interface: 'interface',
  externalHttp: '→ external HTTP',
  database: 'database',
  framework: 'framework',
  cycle: 'cycle ↻',
  depthCap: 'depth limit',
  dynamic: 'runtime',
  opaque: 'no body',
};

/**
 * Inspector tab that renders the call-graph tree for the selected node's endpoint. Fetches
 * the cached server-side tree on mount; falls back to "not built yet" when warmup hasn't
 * touched it. Provides a "Rebuild" button so the user can re-walk after editing code.
 */
export function CallGraphTab({ endpointId }: Props) {
  const [graph, setGraph] = useState<CallGraphDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    if (!endpointId) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setGraph(null);
    (async () => {
      try {
        const g = await getCallGraph(endpointId);
        if (!cancelled) setGraph(g);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [endpointId]);

  async function rebuild() {
    if (!endpointId) return;
    setRebuilding(true);
    try {
      await rebuildCallGraphs();
      const g = await getCallGraph(endpointId);
      setGraph(g);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRebuilding(false);
    }
  }

  if (!endpointId) {
    return (
      <div className="tab-pane-content">
        <div className="muted small">{`> select a node mapped to a discovered endpoint to see its call graph.`}</div>
      </div>
    );
  }

  return (
    <div className="tab-pane-content cg-pane">
      <div className="cg-head">
        <span className="term-heading term-heading-comment">{`# call graph for ${endpointId}`}</span>
        <button className="term-action" onClick={rebuild} disabled={rebuilding}>
          {rebuilding ? '…rebuilding' : '[rebuild]'}
        </button>
      </div>
      {loading && <div className="muted small">loading…</div>}
      {err && <div className="error small">{`[!] ${err}`}</div>}
      {!loading && !err && !graph && (
        <div className="muted small">
          {`> no graph yet — warmup may still be running, or this endpoint's handler couldn't be resolved.`}
        </div>
      )}
      {graph && (
        <>
          <div className="muted small cg-meta">
            generated {new Date(graph.generatedAt).toLocaleTimeString()} · {graph.rootMethod}
          </div>
          {graph.warnings && graph.warnings.length > 0 && (
            <details className="cg-warnings">
              <summary>{`! ${graph.warnings.length} warning(s)`}</summary>
              <ul>{graph.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          <div className="cg-tree">
            <CallNodeView node={graph.rootCall} depth={0} steps={buildStepMap(graph)} />
          </div>
        </>
      )}
    </div>
  );
}

function CallNodeView({ node, depth, steps }: { node: CallNodeDto; depth: number; steps: Map<CallNodeDto, number> }) {
  const [open, setOpen] = useState(depth < 4);
  const hasKids = (node.calls?.length ?? 0) > 0;
  const step = steps.get(node);

  // Property / event accessors render as compact "→ Property" rows — they're high-frequency
  // noise in any non-trivial method body and adding a full row each ruins scannability.
  const accessor = detectAccessor(node);
  if (accessor) {
    return (
      <div className={`cg-accessor cg-accessor-${accessor.kind}`} style={{ paddingLeft: `${depth * 1.1}rem` }}>
        <span className="cg-step">{step}</span>
        <span className="cg-accessor-arrow" title={accessor.kind === 'get' ? 'read' : 'write'}>
          {accessor.kind === 'get' ? '←' : '→'}
        </span>
        <span className="cg-accessor-name">
          {accessor.typeName}<span className="cg-accessor-dot">.</span>{accessor.propName}
        </span>
      </div>
    );
  }

  // Constructor calls: smaller, distinct treatment ("new Foo()") so they don't compete with
  // real method calls visually.
  const isCtor = node.methodName === '.ctor';

  return (
    <div className={`cg-node cg-kind-${node.kind}${isCtor ? ' cg-ctor' : ''}`} style={{ paddingLeft: `${depth * 1.1}rem` }}>
      <div className="cg-row">
        <span className="cg-step">{step}</span>
        <button
          className="cg-toggle"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasKids}
          aria-label={open ? 'collapse' : 'expand'}
        >
          {hasKids ? (open ? '▾' : '▸') : '·'}
        </button>
        <span className="cg-badge">{KIND_BADGE[node.kind]}</span>
        <span className="cg-name">{node.displayName}</span>
        {node.resolvedImplType && (
          <span className="cg-impl">→ {shortenType(node.resolvedImplType)}</span>
        )}
        {node.notes && <span className="cg-notes muted small">{node.notes}</span>}
        {node.summary && (
          <span className="cg-info" data-summary={node.summary} aria-label="info" tabIndex={0}>ⓘ</span>
        )}
        {node.filePath && node.lineNumber != null && (
          <span
            className="cg-source muted small"
            title={`${node.filePath}:${node.lineNumber} (click to copy)`}
            onClick={() => navigator.clipboard.writeText(`${node.filePath}:${node.lineNumber}`).catch(() => {})}
          >
            {basename(node.filePath)}:{node.lineNumber}
          </span>
        )}
      </div>
      {open && hasKids && (
        <div className="cg-kids">
          {node.calls!.map((c, i) => <CallNodeView key={i} node={c} depth={depth + 1} steps={steps} />)}
        </div>
      )}
    </div>
  );
}

/** DFS pre-order step numbering across the entire tree. Each call site gets a stable
 * 1-based index that reflects the order the engine would actually traverse the tree. */
function buildStepMap(graph: CallGraphDto): Map<CallNodeDto, number> {
  const map = new Map<CallNodeDto, number>();
  let counter = 1;
  function walk(n: CallNodeDto) {
    map.set(n, counter++);
    for (const c of n.calls ?? []) walk(c);
  }
  walk(graph.rootCall);
  return map;
}

/** Detect property / event accessors from the raw IL method name and return the parts the
 * compact renderer needs. Returns <c>null</c> for non-accessor methods. */
function detectAccessor(node: CallNodeDto): { kind: 'get' | 'set'; typeName: string; propName: string } | null {
  const m = node.methodName;
  if (!m) return null;
  const typeName = (node.declaringType?.split('.').pop()) ?? '';
  if (m.startsWith('get_')) return { kind: 'get', typeName, propName: m.slice(4) };
  if (m.startsWith('set_')) return { kind: 'set', typeName, propName: m.slice(4) };
  return null;
}

function shortenType(full: string): string {
  const dot = full.lastIndexOf('.');
  return dot < 0 ? full : full.slice(dot + 1);
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}
