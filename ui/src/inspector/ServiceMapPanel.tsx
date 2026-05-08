import { useEffect, useMemo, useState } from 'react';
import { type ServiceMap, getServiceMap } from '../api';
import { MetricsTable } from './MetricsTable';
import { RadialServiceView } from './RadialServiceView';

interface Props {
  onClose?: () => void;
}

type View = 'radial' | 'metrics';

/**
 * Inspector content. Endpoints listed on the left; the selected endpoint drives the
 * radial diagram. The metrics table view surfaces the same data as a sortable
 * spreadsheet for users who prefer numbers over the diagram.
 */
export function ServiceMapPanel({ onClose }: Props) {
  const [map, setMap] = useState<ServiceMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [view, setView] = useState<View>('radial');
  const [islandFilter, setIslandFilter] = useState<number | null>(null);

  useEffect(() => { reload(); }, []);

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
        if (!selectedEndpoint) {
          const first = m.nodes.find((n) => n.kind === 'endpoint');
          if (first) setSelectedEndpoint(first.id);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const endpoints = useMemo(() => {
    if (!map) return [];
    return map.nodes
      .filter((n) => n.kind === 'endpoint')
      .sort((a, b) => b.metrics.coupling - a.metrics.coupling);
  }, [map]);

  const islands = map?.islands ?? [];
  const selectedNode = map?.nodes.find((n) => n.id === highlightId);

  return (
    <div className="inspector-panel">
      <div className="inspector-panel-head">
        <h2>System Inspector</h2>
        <div className="inspector-panel-actions">
          <button
            className={`inspector-tab${view === 'radial' ? ' active' : ''}`}
            onClick={() => setView('radial')}
          >Radial</button>
          <button
            className={`inspector-tab${view === 'metrics' ? ' active' : ''}`}
            onClick={() => setView('metrics')}
          >Metrics</button>
          <button className="link-btn" onClick={reload}>Refresh</button>
          {onClose && <button className="agent-panel-iconbtn" onClick={onClose} title="Close">×</button>}
        </div>
      </div>

      {loading && <div className="muted small">Loading…</div>}
      {error && <div className="agent-panel-error">{error}</div>}

      {!loading && map && (
        <div className="inspector-body">
          <div className="inspector-sidebar">
            <div className="inspector-sidebar-head">
              <h3>Endpoints</h3>
              <span className="muted small">{endpoints.length} total</span>
            </div>
            <ul className="inspector-endpoint-list">
              {endpoints.map((ep) => (
                <li
                  key={ep.id}
                  className={ep.id === selectedEndpoint ? 'selected' : ''}
                  onClick={() => { setSelectedEndpoint(ep.id); setHighlightId(null); }}
                >
                  <div className="inspector-endpoint-row">
                    <span className={`inspector-method method-${(ep.httpMethod ?? '').toLowerCase()}`}>{ep.httpMethod}</span>
                    <span className="inspector-endpoint-path" title={ep.fullName ?? ep.id}>{ep.label}</span>
                  </div>
                  <div className="inspector-endpoint-meta muted small">
                    <span>↘ {ep.metrics.serviceReach}</span>
                    <span>🌐 {ep.metrics.externalReach}</span>
                    <span>💾 {ep.metrics.databaseReach}</span>
                    <span>📏 {ep.metrics.depth}</span>
                  </div>
                </li>
              ))}
            </ul>

            {islands.length > 0 && (
              <div className="inspector-islands">
                <div className="inspector-sidebar-head">
                  <h3>Islands</h3>
                  <span className="muted small">{islands.length} clusters</span>
                </div>
                <div className="inspector-island-chips">
                  <button
                    className={`island-chip${islandFilter === null ? ' active' : ''}`}
                    onClick={() => setIslandFilter(null)}
                  >all</button>
                  {islands.map((isl, i) => (
                    <button
                      key={i}
                      className={`island-chip${islandFilter === i ? ' active' : ''}`}
                      onClick={() => setIslandFilter(i)}
                      title={`${isl.length} node${isl.length === 1 ? '' : 's'}`}
                    >
                      {i + 1} <span className="muted">({isl.length})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="inspector-content">
            {view === 'radial' && selectedEndpoint && (
              <RadialServiceView
                map={map}
                endpointId={selectedEndpoint}
                onNodeClick={setHighlightId}
              />
            )}
            {view === 'metrics' && (
              <MetricsTable
                map={map}
                onPick={setHighlightId}
                selectedId={highlightId}
                filterIsland={islandFilter}
              />
            )}

            {selectedNode && (
              <div className="inspector-detail">
                <div className="inspector-detail-head">
                  <span className={`kind-cell kind-${selectedNode.kind}`}>{selectedNode.kind}</span>
                  <code>{selectedNode.fullName ?? selectedNode.id}</code>
                </div>
                <dl className="inspector-detail-grid">
                  <Stat label="Coupling" value={selectedNode.metrics.coupling.toFixed(0)} />
                  <Stat label="Fan-in" value={selectedNode.metrics.fanIn} />
                  <Stat label="Fan-out" value={selectedNode.metrics.fanOut} />
                  <Stat label="Depth" value={selectedNode.metrics.depth} />
                  <Stat label="External" value={selectedNode.metrics.externalReach} />
                  <Stat label="DB" value={selectedNode.metrics.databaseReach} />
                  <Stat label="Service reach" value={selectedNode.metrics.serviceReach} />
                  <Stat label="Instability" value={
                    selectedNode.metrics.instability === null ? '—' : selectedNode.metrics.instability.toFixed(2)
                  } />
                  {selectedNode.kind === 'endpoint' && <Stat label="Sibling endpoints" value={selectedNode.metrics.siblingEndpoints} />}
                  {selectedNode.resolvedImplType && (
                    <Stat label="Impl" value={selectedNode.resolvedImplType.split('.').slice(-1)[0]} />
                  )}
                </dl>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
