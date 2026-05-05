import { useEffect, useMemo, useState } from 'react';
import { listEndpoints, type EndpointDescriptor } from './api';
import { QuickCallPanel } from './QuickCallPanel';

export const ENDPOINT_DRAG_MIME = 'application/x-utopia-endpoint';

interface Props {
  onError?: (msg: string) => void;
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Sidebar endpoint palette. Drag-source for drop-onto-canvas. Two grouping modes (HTTP method
 * or logical area), plus a free-text filter that matches method+path+area+purpose.
 */
export function EndpointPalette({ onError }: Props) {
  const [endpoints, setEndpoints] = useState<EndpointDescriptor[]>([]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quickCallEp, setQuickCallEp] = useState<EndpointDescriptor | null>(null);

  useEffect(() => {
    listEndpoints()
      .then(setEndpoints)
      .catch((e: Error) => onError?.(e.message));
  }, [onError]);

  const filtered = useMemo(() => {
    if (!filter) return endpoints;
    const q = filter.toLowerCase();
    return endpoints.filter((e) =>
      `${e.method} ${e.path} ${e.area ?? ''} ${e.purpose ?? ''}`.toLowerCase().includes(q)
    );
  }, [endpoints, filter]);

  const groups = useMemo(() => groupEndpoints(filtered), [filtered]);

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
              {open && g.items && renderItems(g.items, setQuickCallEp)}
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
                        {subOpen && renderItems(sg.items, setQuickCallEp)}
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

function renderItems(items: EndpointDescriptor[], openQuickCall: (ep: EndpointDescriptor) => void) {
  return (
    <div className="palette-group-items">
      {items.map((ep) => (
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
          <span className="palette-path">{ep.path}</span>
        </div>
      ))}
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

function groupEndpoints(endpoints: EndpointDescriptor[]): Group[] {
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
        items: items.sort((a, b) => a.path.localeCompare(b.path)),
      };
    });
}
