import { useMemo, useState } from 'react';
import type { ServiceMap, ServiceMapNode } from '../api';

interface Props {
  map: ServiceMap;
  onPick?: (id: string) => void;
  selectedId?: string | null;
  /** When provided, restricts rows to nodes inside the same island. */
  filterIsland?: number | null;
}

type SortKey = 'label' | 'kind' | 'coupling' | 'fanIn' | 'fanOut' | 'depth' | 'externalReach' | 'databaseReach' | 'instability';

/**
 * Sortable per-node metrics. Columns mirror <see cref="ServiceMapMetrics"/>.
 * Click a column header to flip the sort direction. Click a row to surface that
 * node in the radial view.
 */
export function MetricsTable({ map, onPick, selectedId, filterIsland }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('coupling');
  const [sortAsc, setSortAsc] = useState(false);

  const rows = useMemo(() => {
    let nodes = map.nodes;
    if (filterIsland !== null && filterIsland !== undefined) {
      nodes = nodes.filter((n) => n.islandIndex === filterIsland);
    }
    return [...nodes].sort((a, b) => cmp(a, b, sortKey) * (sortAsc ? 1 : -1));
  }, [map.nodes, sortKey, sortAsc, filterIsland]);

  function toggle(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  return (
    <div className="metrics-table">
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

function CouplingBar({ value }: { value: number }) {
  const w = Math.min(100, Math.max(0, value));
  const tone = w < 34 ? '--node-tone-cool' : w < 67 ? '--node-tone-warm' : '--node-tone-hot';
  return (
    <div className="coupling-bar">
      <div className="coupling-bar-fill" style={{ width: `${w}%`, background: `var(${tone})` }} />
      <span className="coupling-bar-label">{value.toFixed(0)}</span>
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

function formatInstability(v: number | null): string {
  return v === null ? '—' : v.toFixed(2);
}

function cmp(a: ServiceMapNode, b: ServiceMapNode, key: SortKey): number {
  switch (key) {
    case 'label': return a.label.localeCompare(b.label);
    case 'kind': return a.kind.localeCompare(b.kind);
    case 'instability': return (a.metrics.instability ?? -1) - (b.metrics.instability ?? -1);
    default: return (a.metrics[key] as number) - (b.metrics[key] as number);
  }
}
