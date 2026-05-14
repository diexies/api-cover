import { useEffect, useMemo, useState } from 'react';
import type { ServiceMap, ServiceMapNode } from '../api';
import { MetricsCallersModal } from './MetricsCallersModal';

interface Props {
  map: ServiceMap;
  onPick?: (id: string) => void;
  selectedId?: string | null;
  /** When provided, restricts rows to nodes inside the same island. */
  filterIsland?: number | null;
  /** When set, the right-click "View integrated area" modal can hand a service id back
   * to the parent so it can flip to the tree view and pin the node via requestedFocus. */
  onFocus?: (id: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: ServiceMapNode;
}

type SortKey = 'label' | 'kind' | 'coupling' | 'fanIn' | 'fanOut' | 'depth' | 'externalReach' | 'databaseReach' | 'instability';

/**
 * Sortable per-node metrics. Columns mirror <see cref="ServiceMapMetrics"/>.
 * Click a column header to flip the sort direction. Click a row to surface that
 * node in the radial view.
 */
type KindFilter = 'all' | ServiceMapNode['kind'];

export function MetricsTable({ map, onPick, selectedId, filterIsland, onFocus }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('coupling');
  const [sortAsc, setSortAsc] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [modalNode, setModalNode] = useState<ServiceMapNode | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close, { capture: true });
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
    };
  }, [menu]);

  const rows = useMemo(() => {
    let nodes = map.nodes;
    if (filterIsland !== null && filterIsland !== undefined) {
      nodes = nodes.filter((n) => n.islandIndex === filterIsland);
    }
    if (kindFilter !== 'all') {
      nodes = nodes.filter((n) => n.kind === kindFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      nodes = nodes.filter((n) =>
        n.label.toLowerCase().includes(q) ||
        (n.fullName ?? n.id).toLowerCase().includes(q),
      );
    }
    return [...nodes].sort((a, b) => cmp(a, b, sortKey) * (sortAsc ? 1 : -1));
  }, [map.nodes, sortKey, sortAsc, filterIsland, kindFilter, search]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: map.nodes.length, endpoint: 0, service: 0, externalHttp: 0, database: 0 };
    for (const n of map.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    return counts;
  }, [map.nodes]);

  function toggle(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  const KINDS: { key: KindFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'endpoint', label: 'API' },
    { key: 'service', label: 'Service' },
    { key: 'database', label: 'DB' },
    { key: 'externalHttp', label: 'HTTP' },
  ];

  return (
    <div className="metrics-table">
      <div className="metrics-toolbar">
        <input
          type="search"
          className="metrics-search"
          placeholder="filter by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="search metrics rows"
        />
        <div className="metrics-kind-filter" role="tablist" aria-label="filter by kind">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="tab"
              aria-selected={kindFilter === k.key}
              className={`metrics-kind-btn${kindFilter === k.key ? ' is-active' : ''}`}
              onClick={() => setKindFilter(k.key)}
            >
              {k.label} <span className="metrics-kind-count">{kindCounts[k.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="metrics-count muted small">{rows.length} / {map.nodes.length}</div>
      </div>
      <table>
        <thead>
          <tr>
            <Th onClick={() => toggle('kind')} active={sortKey === 'kind'}>Kind</Th>
            <Th onClick={() => toggle('label')} active={sortKey === 'label'}>Name</Th>
            <Th onClick={() => toggle('coupling')} active={sortKey === 'coupling'}>Coupling</Th>
            <Th onClick={() => toggle('fanIn')} active={sortKey === 'fanIn'}>Fan-in</Th>
            <Th onClick={() => toggle('fanOut')} active={sortKey === 'fanOut'}>Fan-out</Th>
            <Th onClick={() => toggle('depth')} active={sortKey === 'depth'}>Depth</Th>
            <Th onClick={() => toggle('externalReach')} active={sortKey === 'externalReach'}>Ext</Th>
            <Th onClick={() => toggle('databaseReach')} active={sortKey === 'databaseReach'}>DB</Th>
            <Th onClick={() => toggle('instability')} active={sortKey === 'instability'}>I</Th>
            <Th>Island</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr
              key={n.id}
              className={n.id === selectedId ? 'is-selected' : ''}
              onClick={() => onPick?.(n.id)}
              onContextMenu={(e) => {
                // Only services have a meaningful caller list — for endpoints / boundaries
                // there's nothing to surface, so we skip the menu and let the browser
                // show its default.
                if (n.kind !== 'service') return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node: n });
              }}
            >
              <td><KindCell node={n} /></td>
              <td className="metrics-name" title={n.fullName ?? n.id}>{n.label}</td>
              <td><CouplingBar value={n.metrics.coupling} /></td>
              <td className="num">{n.metrics.fanIn}</td>
              <td className="num">{n.metrics.fanOut}</td>
              <td className="num">{n.metrics.depth}</td>
              <td className="num">{n.metrics.externalReach}</td>
              <td className="num">{n.metrics.databaseReach}</td>
              <td className="num">{formatInstability(n.metrics.instability)}</td>
              <td className="num"><IslandBadge index={n.islandIndex} totalIslands={map.islands.length} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu && (
        <div
          className="metrics-context-menu"
          style={{ position: 'fixed', top: menu.y, left: menu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="metrics-context-item"
            onClick={() => { setModalNode(menu.node); setMenu(null); }}
          >View integrated area</button>
        </div>
      )}
      {modalNode && (
        <MetricsCallersModal
          serviceId={modalNode.id}
          shortName={modalNode.label}
          onFocus={onFocus}
          onClose={() => setModalNode(null)}
        />
      )}
    </div>
  );
}

function Th({ children, onClick, active }: { children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <th onClick={onClick} className={`${onClick ? 'sortable' : ''} ${active ? 'active' : ''}`.trim()}>
      {children}
    </th>
  );
}

function KindCell({ node }: { node: ServiceMapNode }) {
  const map: Record<ServiceMapNode['kind'], { icon: string; label: string }> = {
    endpoint: { icon: '⚡', label: 'API' },
    service: { icon: '⊟', label: node.isInterface ? 'Iface' : 'Class' },
    externalHttp: { icon: '🌐', label: 'HTTP' },
    database: { icon: '💾', label: 'DB' },
  };
  const { icon, label } = map[node.kind];
  return <span className={`kind-cell kind-${node.kind}`}><span className="kind-icon">{icon}</span> {label}</span>;
}

function CouplingBar({ value }: { value: number | null | undefined }) {
  const v = value ?? 0;
  const w = Math.min(100, Math.max(0, v));
  const tone = w < 34 ? '--node-tone-cool' : w < 67 ? '--node-tone-warm' : '--node-tone-hot';
  return (
    <div className="coupling-bar">
      <div className="coupling-bar-fill" style={{ width: `${w}%`, background: `var(${tone})` }} />
      <span className="coupling-bar-label">{v.toFixed(0)}</span>
    </div>
  );
}

function IslandBadge({ index, totalIslands }: { index: number; totalIslands: number }) {
  const hue = totalIslands === 0 ? 0 : (index * 137) % 360;
  return (
    <span
      className="island-badge"
      style={{ background: `hsl(${hue}, 70%, 92%)`, color: `hsl(${hue}, 70%, 28%)` }}
      title={`Island ${index + 1} of ${totalIslands}`}
    >
      {index + 1}
    </span>
  );
}

function formatInstability(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2);
}

function cmp(a: ServiceMapNode, b: ServiceMapNode, key: SortKey): number {
  switch (key) {
    case 'label': return a.label.localeCompare(b.label);
    case 'kind': return a.kind.localeCompare(b.kind);
    case 'instability': return (a.metrics.instability ?? -1) - (b.metrics.instability ?? -1);
    default: return (a.metrics[key] as number) - (b.metrics[key] as number);
  }
}
