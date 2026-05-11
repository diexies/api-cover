import { useEffect, useMemo, useState } from 'react';
import { listEndpoints, type EndpointDescriptor } from './api';
import { QuickCallPanel } from './QuickCallPanel';

export const ENDPOINT_DRAG_MIME = 'application/x-utopia-endpoint';

interface Props {
  onError?: (msg: string) => void;
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// API version detection: matches `/v1`, `/v23`, `/V2` segments inside a path.
// Lookahead enforces the segment ends at `/` or end-of-string so `/version1`
// or `/v1foo` don't match.
const VERSION_RE = /\/v(\d+)(?=\/|$)/i;

interface ParsedVersion {
  version: string | null;
  versionNumber: number;
  basePath: string;
}

function parseVersion(path: string): ParsedVersion {
  const m = path.match(VERSION_RE);
  if (!m) return { version: null, versionNumber: 0, basePath: path };
  return {
    version: `v${m[1]}`,
    versionNumber: Number(m[1]),
    basePath: path.replace(VERSION_RE, ''),
  };
}

/**
 * Sidebar endpoint palette. Drag-source for drop-onto-canvas. Two grouping modes (HTTP method
 * or logical area), plus a free-text filter that matches method+path+area+purpose.
 */
export function EndpointPalette({ onError }: Props) {
  const [endpoints, setEndpoints] = useState<EndpointDescriptor[]>([]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quickCallEp, setQuickCallEp] = useState<EndpointDescriptor | null>(null);
  // Default to "latest" so a multi-version surface lands clean instead of
  // dumping every v1/v2/v3 row at once. When no multi-version conflict exists
  // anywhere this state is effectively ignored.
  const [versionFilter, setVersionFilter] = useState<string>('latest');

  useEffect(() => {
    listEndpoints()
      .then(setEndpoints)
      .catch((e: Error) => onError?.(e.message));
  }, [onError]);

  // Pre-compute version metadata: which (method, basePath) pairs have more
  // than one version (conflictingBases), which versions exist at all, and
  // the max version per base for the "latest" filter.
  const versionAnalysis = useMemo(() => {
    const versionsByBase = new Map<string, Set<string>>();
    const maxByBase = new Map<string, number>();
    const allVersions = new Set<string>();
    for (const ep of endpoints) {
      const { version, versionNumber, basePath } = parseVersion(ep.path);
      if (!version) continue;
      const key = `${ep.method.toUpperCase()} ${basePath}`;
      allVersions.add(version);
      if (!versionsByBase.has(key)) versionsByBase.set(key, new Set());
      versionsByBase.get(key)!.add(version);
      maxByBase.set(key, Math.max(maxByBase.get(key) ?? 0, versionNumber));
    }
    const conflictingBases = new Set<string>();
    for (const [key, set] of versionsByBase) {
      if (set.size > 1) conflictingBases.add(key);
    }
    const sortedVersions = [...allVersions].sort((a, b) =>
      Number(b.slice(1)) - Number(a.slice(1)),
    );
    return { allVersions, sortedVersions, conflictingBases, maxByBase };
  }, [endpoints]);

  const hasMultipleVersions = versionAnalysis.allVersions.size > 1;

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return endpoints.filter((e) => {
      if (q && !`${e.method} ${e.path} ${e.area ?? ''} ${e.purpose ?? ''}`.toLowerCase().includes(q)) {
        return false;
      }
      if (!hasMultipleVersions || versionFilter === 'all') return true;
      const { version, versionNumber, basePath } = parseVersion(e.path);
      if (!version) return true;
      const key = `${e.method.toUpperCase()} ${basePath}`;
      if (versionFilter === 'latest') {
        const max = versionAnalysis.maxByBase.get(key) ?? versionNumber;
        return versionNumber === max;
      }
      return version === versionFilter;
    });
  }, [endpoints, filter, versionFilter, hasMultipleVersions, versionAnalysis]);

  const groups = useMemo(
    () => groupEndpoints(filtered, versionAnalysis.conflictingBases, versionFilter),
    [filtered, versionAnalysis.conflictingBases, versionFilter],
  );

  function toggleGroup(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="palette">
      {quickCallEp && (
        <QuickCallPanel endpoint={quickCallEp} onClose={() => setQuickCallEp(null)} />
      )}
      <div className="palette-controls">
        <input
          className="palette-filter"
          placeholder="search endpoints…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {hasMultipleVersions && (
          <div className="palette-version-filter" role="radiogroup" aria-label="api version filter">
            <button
              type="button"
              role="radio"
              aria-checked={versionFilter === 'latest'}
              className={`palette-version-pill${versionFilter === 'latest' ? ' is-active' : ''}`}
              onClick={() => setVersionFilter('latest')}
              title="Show only the highest version of each conflicting endpoint"
            >latest</button>
            <button
              type="button"
              role="radio"
              aria-checked={versionFilter === 'all'}
              className={`palette-version-pill${versionFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setVersionFilter('all')}
            >all</button>
            {versionAnalysis.sortedVersions.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={versionFilter === v}
                className={`palette-version-pill${versionFilter === v ? ' is-active' : ''}`}
                onClick={() => setVersionFilter(v)}
              >{v}</button>
            ))}
          </div>
        )}
      </div>
      <div className="palette-groups">
        {groups.length === 0 && <span className="muted small">no endpoints</span>}
        {groups.map((g) => {
          const open = !collapsed.has(g.name);
          return (
            <div key={g.name} className="palette-group">
              <div
                className={`palette-group-head ${open ? 'open' : ''}`}
                onClick={() => toggleGroup(g.name)}
              >
                <span className="caret">{open ? '▾' : '▸'}</span>
                <span className={`method-badge method-${g.name.toLowerCase()}`}>{g.name}</span>
                {g.subtitle && <span className="palette-group-sub">{g.subtitle}</span>}
                <span className="palette-group-count">{g.count}</span>
              </div>
              {open && g.items && renderItems(g.items, setQuickCallEp, versionAnalysis.conflictingBases, versionFilter)}
              {open && g.subgroups && (
                <div className="palette-subgroups">
                  {g.subgroups.map((sg) => {
                    const subKey = `${g.name}::${sg.name}`;
                    const subOpen = !collapsed.has(subKey);
                    return (
                      <div key={subKey} className="palette-subgroup">
                        <div
                          className={`palette-subgroup-head ${subOpen ? 'open' : ''}`}
                          onClick={() => toggleGroup(subKey)}
                        >
                          <span className="caret">{subOpen ? '▾' : '▸'}</span>
                          <span className="palette-subgroup-name">{sg.name}</span>
                          {sg.subtitle && <span className="palette-group-sub">{sg.subtitle}</span>}
                          <span className="palette-group-count">{sg.items.length}</span>
                        </div>
                        {subOpen && renderItems(sg.items, setQuickCallEp, versionAnalysis.conflictingBases, versionFilter)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderItems(
  items: EndpointDescriptor[],
  openQuickCall: (ep: EndpointDescriptor) => void,
  conflictingBases: ReadonlySet<string>,
  versionFilter: string,
) {
  return (
    <div className="palette-group-items">
      {items.map((ep) => {
        const { version, basePath } = parseVersion(ep.path);
        const key = `${ep.method.toUpperCase()} ${basePath}`;
        // Show the version chip only when (a) the same base path has more than
        // one version somewhere in the catalogue AND (b) the user is currently
        // viewing all versions side-by-side. Otherwise the version segment is
        // redundant noise — the full path stays in the tooltip.
        const showVersionChip = version !== null && conflictingBases.has(key) && versionFilter === 'all';
        const displayPath = version !== null && (showVersionChip || versionFilter !== 'all')
          ? basePath
          : ep.path;
        return (
          <div
            key={ep.id}
            className="palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ENDPOINT_DRAG_MIME, JSON.stringify(ep));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openQuickCall(ep);
            }}
            title={`${ep.method} ${ep.path}${ep.area ? ` · ${ep.area}` : ''}${ep.purpose ? ` · ${ep.purpose}` : ''} — right-click for Quick Call`}
          >
            <span className={`method-badge method-${ep.method.toLowerCase()}`}>{ep.method}</span>
            {showVersionChip && <span className="palette-version-chip">{version}</span>}
            <span className="palette-path">{displayPath}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Two-level group: top is the primary key (method or area), each contains nested subgroups
 * (always area when grouping by method; not used when grouping by area).
 */
interface Group {
  name: string;
  subtitle?: string;
  items?: EndpointDescriptor[];      // leaf items (used when no subgroups)
  subgroups?: Subgroup[];             // optional nested grouping
  count: number;
}
interface Subgroup {
  name: string;
  subtitle?: string;
  items: EndpointDescriptor[];
}

function groupEndpoints(
  endpoints: EndpointDescriptor[],
  _conflictingBases: ReadonlySet<string>,
  _versionFilter: string,
): Group[] {
  // Top-level: HTTP method. Inside each method, sub-grouped by area.
  const byMethod = new Map<string, EndpointDescriptor[]>();
  for (const ep of endpoints) {
    const key = ep.method.toUpperCase();
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key)!.push(ep);
  }
  const orderedMethods = METHOD_ORDER.filter((m) => byMethod.has(m));
  for (const k of byMethod.keys()) if (!orderedMethods.includes(k)) orderedMethods.push(k);

  return orderedMethods.map((method) => {
    const list = byMethod.get(method) ?? [];
    const subgroups = groupByArea(list);
    return { name: method, subgroups, count: list.length };
  });
}

function groupByArea(endpoints: EndpointDescriptor[]): Subgroup[] {
  const map = new Map<string, EndpointDescriptor[]>();
  for (const ep of endpoints) {
    const key = ep.area && ep.area.length > 0 ? ep.area : 'uncategorized';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ep);
  }
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === 'uncategorized') return 1;
      if (b[0] === 'uncategorized') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, items]) => {
      const purposes = [...new Set(items.map((i) => i.purpose).filter(Boolean))] as string[];
      return {
        name,
        subtitle: purposes.length > 0 ? purposes.join(' · ') : undefined,
        // Sort by version-stripped path so v1/v2 of the same resource land
        // adjacent in the list (numerically descending within a base — newest
        // version first).
        items: items.sort((a, b) => {
          const av = parseVersion(a.path);
          const bv = parseVersion(b.path);
          const baseCmp = av.basePath.localeCompare(bv.basePath);
          if (baseCmp !== 0) return baseCmp;
          return bv.versionNumber - av.versionNumber;
        }),
      };
    });
}
