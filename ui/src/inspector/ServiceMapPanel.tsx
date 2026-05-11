import { useEffect, useMemo, useState } from 'react';
import { type ServiceMap, type ServiceMapEdge, type ServiceMapNode, type ServiceMapNodeKind, getServiceMap } from '../api';
import { MetricsTable } from './MetricsTable';
import { SystemMapView } from './SystemMapView';

interface Props {
  onClose?: () => void;
}

type View = 'map' | 'metrics';

const ALL_KINDS: ServiceMapNodeKind[] = ['endpoint', 'service', 'externalHttp', 'database'];

const KIND_LABEL: Record<ServiceMapNodeKind, string> = {
  endpoint: 'endpoints',
  service: 'services',
  externalHttp: 'external',
  database: 'data',
};

/**
 * Editorial system overview. The Map view is the page — every endpoint /
 * service / external / data node visible at once on a single concentric web.
 * Filters and search shape the rendered subgraph; clicking a node pins the
 * detail strip at the bottom. The Metrics tab is a sortable spreadsheet for
 * users who prefer numbers.
 */
export function ServiceMapPanel({ onClose }: Props) {
  const [map, setMap] = useState<ServiceMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<View>('map');
  const [search, setSearch] = useState('');
  const [visibleKinds, setVisibleKinds] = useState<Set<ServiceMapNodeKind>>(() => new Set(ALL_KINDS));
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => { void reload(); }, []);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const m = await getServiceMap();
      if (!m) {
        setError('Service map unavailable. Enable EnableCallGraphInspection in APICoverOptions.');
        setMap(null);
      } else {
        setMap(m);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggleKind(k: ServiceMapNodeKind) {
    setVisibleKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      // Never let the user end up with zero kinds — the canvas would go blank.
      if (next.size === 0) next.add(k);
      return next;
    });
  }

  const counts = useMemo(() => countByKind(map), [map]);
  const totalEdges = map?.edges.length ?? 0;
  const islandCount = map?.islands.length ?? 0;
  const selectedNode = useMemo(
    () => (map && selectedId ? map.nodes.find((n) => n.id === selectedId) ?? null : null),
    [map, selectedId],
  );
  const topCoupled = useMemo(() => {
    if (!map) return [];
    return [...map.nodes]
      .filter((n) => !n.isIsolated)
      .sort((a, b) => b.metrics.coupling - a.metrics.coupling)
      .slice(0, 5);
  }, [map]);

  // Endpoints whose call graph had no detectable service / DB / external edge.
  // Listed here instead of on the canvas so the user sees them as a backlog
  // ("no backing store discovered yet") rather than as broken graph data.
  const isolatedEndpoints = useMemo(() => {
    if (!map) return [];
    return map.nodes.filter((n) => n.isIsolated && n.kind === 'endpoint');
  }, [map]);

  return (
    <section className="sysmap" aria-label="system map">
      <header className="sysmap-head">
        <div className="sysmap-head-left">
          <h2 className="sysmap-title">System Map</h2>
          <p className="sysmap-summary">
            <Stat label="endpoints" value={counts.endpoint} />
            <Sep />
            <Stat label="services" value={counts.service} />
            <Sep />
            <Stat label="data" value={counts.database} />
            <Sep />
            <Stat label="external" value={counts.externalHttp} />
            <Sep />
            <Stat label="links" value={totalEdges} />
            {islandCount > 1 && (
              <>
                <Sep />
                <Stat label="islands" value={islandCount} />
              </>
            )}
          </p>
        </div>
        <div className="sysmap-head-right">
          <button
            className={`sysmap-view-btn${view === 'map' ? ' is-active' : ''}`}
            onClick={() => setView('map')}
          >Map</button>
          <button
            className={`sysmap-view-btn${view === 'metrics' ? ' is-active' : ''}`}
            onClick={() => setView('metrics')}
          >Metrics</button>
          <button className="sysmap-view-btn" onClick={() => void reload()} title="Refresh service map">↻</button>
          {onClose && (
            <button className="sysmap-view-btn sysmap-close" onClick={onClose} title="Close" aria-label="close">×</button>
          )}
        </div>
      </header>

      <div className="sysmap-controls">
        <div className="sysmap-kinds" role="group" aria-label="visible node kinds">
          {ALL_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`sysmap-kind kind-${k}${visibleKinds.has(k) ? ' is-on' : ''}`}
              onClick={() => toggleKind(k)}
              aria-pressed={visibleKinds.has(k)}
            >
              <span className={`sysmap-kind-glyph glyph-${k}`} aria-hidden="true" />
              <span className="sysmap-kind-label">{KIND_LABEL[k]}</span>
              <span className="sysmap-kind-count">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          className="sysmap-search"
          type="search"
          placeholder="filter by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="search nodes"
        />
      </div>

      {loading && <div className="sysmap-status">Loading…</div>}
      {error && <div className="sysmap-status sysmap-error">{error}</div>}

      {!loading && !error && map && (
        <div className="sysmap-stage">
          {view === 'map' && (
            <SystemMapView
              map={map}
              visibleKinds={visibleKinds}
              search={search}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {view === 'metrics' && (
            <div className="sysmap-metrics">
              <MetricsTable
                map={map}
                onPick={setSelectedId}
                selectedId={selectedId}
                filterIsland={null}
              />
            </div>
          )}

          <aside className="sysmap-side" aria-label="hot spots">
            <div className="sysmap-side-section">
              <h3 className="sysmap-side-title">Hot spots</h3>
              <p className="sysmap-side-hint">Top by coupling — touch these to feel the system.</p>
              <ul className="sysmap-side-list">
                {topCoupled.map((n) => (
                  <li
                    key={n.id}
                    className={`sysmap-side-row${selectedId === n.id ? ' is-active' : ''}`}
                    onClick={() => { setSelectedId(n.id); setView('map'); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setSelectedId(n.id); setView('map'); } }}
                  >
                    <span className={`sysmap-side-dot dot-${n.kind}`} aria-hidden="true" />
                    <span className="sysmap-side-label" title={n.fullName ?? n.label}>{n.label}</span>
                    <span className="sysmap-side-metric">{Math.round(n.metrics.coupling)}</span>
                  </li>
                ))}
                {topCoupled.length === 0 && (
                  <li className="sysmap-side-empty">No nodes discovered yet.</li>
                )}
              </ul>
            </div>
            {isolatedEndpoints.length > 0 && (
              <div className="sysmap-side-section">
                <h3 className="sysmap-side-title">No service call</h3>
                <p className="sysmap-side-hint">
                  Endpoints whose body has no detectable service / DB / external call.
                  Likely backed by in-memory state we couldn't classify.
                </p>
                <ul className="sysmap-side-list">
                  {isolatedEndpoints.map((n) => (
                    <li
                      key={n.id}
                      className="sysmap-side-row is-isolated"
                      title={n.fullName ?? n.label}
                    >
                      {n.httpMethod && (
                        <span className={`sysmap-side-method method-${n.httpMethod.toLowerCase()}`}>
                          {n.httpMethod.toUpperCase()}
                        </span>
                      )}
                      <span className="sysmap-side-label">{n.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      )}

      {selectedNode && view === 'map' && (
        <NodeDetailStrip
          node={selectedNode}
          map={map!}
          onClose={() => setSelectedId(null)}
        />
      )}
    </section>
  );
}

/* ─── Bottom detail strip ────────────────────────────────────────────────
   Pinned to the bottom of the panel when a node is selected. Shows identity
   + key metrics + the immediate dependency neighbourhood as chips so the user
   can read "what this depends on" without leaving the overview. */

function NodeDetailStrip({
  node, map, onClose,
}: { node: ServiceMapNode; map: ServiceMap; onClose: () => void }) {
  const outgoing = useMemo(
    () => map.edges.filter((e) => e.from === node.id),
    [map.edges, node.id],
  );
  const incoming = useMemo(
    () => map.edges.filter((e) => e.to === node.id),
    [map.edges, node.id],
  );
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes]);
  const isEndpoint = node.kind === 'endpoint';
  const totalCalls = useMemo(
    () => outgoing.reduce((acc, e) => acc + (e.callSites ?? 0), 0),
    [outgoing],
  );

  return (
    <footer className="sysmap-detail" role="complementary" aria-label="node detail">
      <div className="sysmap-detail-head">
        <span className={`sysmap-detail-glyph glyph-${node.kind}`} aria-hidden="true" />
        <span className="sysmap-detail-kind">{KIND_LABEL[node.kind]}</span>
        {isEndpoint && node.httpMethod && (
          <span className={`sysmap-detail-method method-${node.httpMethod.toLowerCase()}`}>
            {node.httpMethod.toUpperCase()}
          </span>
        )}
        <code className="sysmap-detail-name" title={node.fullName ?? node.id}>
          {node.label}
        </code>
        {node.area && <span className="sysmap-detail-area">{node.area}</span>}
        {node.isInterface && <span className="sysmap-detail-flag">interface</span>}
        <button className="sysmap-detail-close" onClick={onClose} title="Close" aria-label="close detail">×</button>
      </div>
      {node.resolvedImplType && (
        <div className="sysmap-detail-impl" title={node.resolvedImplType}>
          impl <code>{shortType(node.resolvedImplType)}</code>
        </div>
      )}
      <div className="sysmap-detail-metrics">
        <Metric label="coupling" value={Math.round(node.metrics.coupling)} />
        <Metric label="fan-in" value={node.metrics.fanIn} />
        <Metric label="fan-out" value={node.metrics.fanOut} />
        <Metric label="depth" value={node.metrics.depth} />
        <Metric label="services" value={node.metrics.serviceReach} />
        <Metric label="data" value={node.metrics.databaseReach} />
        <Metric label="external" value={node.metrics.externalReach} />
        <Metric
          label="instability"
          value={node.metrics.instability === null ? '—' : node.metrics.instability.toFixed(2)}
        />
        {isEndpoint && (
          <Metric label="siblings" value={node.metrics.siblingEndpoints} />
        )}
        {totalCalls > 0 && <Metric label="call sites" value={totalCalls} />}
      </div>
      <div className="sysmap-detail-deps">
        <DepGroup title="depends on" edges={outgoing} byId={byId} side="to" />
        <DepGroup title="called by"  edges={incoming} byId={byId} side="from" />
      </div>
    </footer>
  );
}

interface DepGroupProps {
  title: string;
  edges: ServiceMapEdge[];
  byId: Map<string, ServiceMapNode>;
  /** Which end of the edge points at the dependency partner (the "other" node). */
  side: 'to' | 'from';
}

function DepGroup({ title, edges, byId, side }: DepGroupProps) {
  // Sort by callSites desc so the heaviest dependency lands first — matches
  // the SVG, where heavy edges paint thicker.
  const sorted = useMemo(
    () => [...edges].sort((a, b) => (b.callSites ?? 0) - (a.callSites ?? 0)),
    [edges],
  );

  if (sorted.length === 0) {
    return (
      <div className="sysmap-dep-group">
        <span className="sysmap-dep-title">{title}</span>
        <span className="sysmap-dep-empty">—</span>
      </div>
    );
  }
  return (
    <div className="sysmap-dep-group">
      <span className="sysmap-dep-title">
        {title} <span className="sysmap-dep-count">{sorted.length}</span>
      </span>
      <ul className="sysmap-dep-list" role="list">
        {sorted.map((e, i) => {
          const partnerId = side === 'to' ? e.to : e.from;
          const n = byId.get(partnerId);
          if (!n) return null;
          const calls = e.callSites ?? 0;
          return (
            <li key={`${e.from}->${e.to}-${i}`} className="sysmap-dep-chip" title={n.fullName ?? n.id}>
              <span className={`sysmap-dep-dot dot-${n.kind}`} aria-hidden="true" />
              <span className="sysmap-dep-name">{truncate(n.label, 24)}</span>
              {calls > 1 && <span className="sysmap-dep-calls">×{calls}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function shortType(fqn: string): string {
  // "Acme.Foo.Services.Impl.UserService" → "UserService". Keeps the inline
  // type readable without losing the long-form available on hover (title attr).
  const parts = fqn.split('.');
  return parts[parts.length - 1] ?? fqn;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function countByKind(map: ServiceMap | null): Record<ServiceMapNodeKind, number> {
  const out: Record<ServiceMapNodeKind, number> = { endpoint: 0, service: 0, externalHttp: 0, database: 0 };
  if (!map) return out;
  for (const n of map.nodes) out[n.kind] += 1;
  return out;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="sysmap-stat">
      <span className="sysmap-stat-value">{value}</span>
      <span className="sysmap-stat-label">{label}</span>
    </span>
  );
}

function Sep() { return <span className="sysmap-stat-sep" aria-hidden="true">·</span>; }

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="sysmap-metric">
      <span className="sysmap-metric-label">{label}</span>
      <span className="sysmap-metric-value">{value}</span>
    </span>
  );
}
