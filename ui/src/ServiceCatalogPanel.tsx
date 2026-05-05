import { useEffect, useMemo, useState } from 'react';
import { getServiceCatalog, type ServiceCatalog, type ServiceUsageEntry, type ExternalBoundary } from './api';

type Tab = 'services' | 'external' | 'database';

interface Props {
  onError?: (msg: string) => void;
}

/**
 * Cross-endpoint service catalog. Aggregates the per-endpoint call graphs into a system
 * map: which interfaces / concrete services exist, how many endpoints reach each, what
 * external HTTP destinations and database boundaries are hit. Three sub-tabs let the user
 * pivot between the views without losing the filter / scroll position of the others.
 */
export function ServiceCatalogPanel({ onError }: Props) {
  const [catalog, setCatalog] = useState<ServiceCatalog | null>(null);
  const [tab, setTab] = useState<Tab>('services');
  const [filter, setFilter] = useState('');
  const [includeImpls, setIncludeImpls] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getServiceCatalog()
      .then((c) => { if (!cancelled) setCatalog(c); })
      .catch((e: Error) => { if (!cancelled) onError?.(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [onError]);

  const services = useMemo(() => {
    if (!catalog) return [];
    let s = catalog.services;
    if (!includeImpls) s = s.filter((x) => x.isInterface);
    if (filter) {
      const q = filter.toLowerCase();
      s = s.filter((x) => x.shortName.toLowerCase().includes(q) || x.declaringType.toLowerCase().includes(q));
    }
    return s;
  }, [catalog, filter, includeImpls]);

  const externals = useMemo(() => {
    if (!catalog) return [];
    if (!filter) return catalog.externalHttp;
    const q = filter.toLowerCase();
    return catalog.externalHttp.filter((x) => x.label.toLowerCase().includes(q));
  }, [catalog, filter]);

  const databases = useMemo(() => {
    if (!catalog) return [];
    if (!filter) return catalog.databases;
    const q = filter.toLowerCase();
    return catalog.databases.filter((x) => x.label.toLowerCase().includes(q));
  }, [catalog, filter]);

  return (
    <div className="svc-panel">
      <div className="svc-tabs">
        <button className={`svc-tab ${tab === 'services' ? 'active' : ''}`} onClick={() => setTab('services')}>
          services <sup>{catalog?.services.filter((s) => includeImpls || s.isInterface).length ?? 0}</sup>
        </button>
        <button className={`svc-tab ${tab === 'external' ? 'active' : ''}`} onClick={() => setTab('external')}>
          external HTTP <sup>{catalog?.externalHttp.length ?? 0}</sup>
        </button>
        <button className={`svc-tab ${tab === 'database' ? 'active' : ''}`} onClick={() => setTab('database')}>
          databases <sup>{catalog?.databases.length ?? 0}</sup>
        </button>
      </div>

      <div className="svc-controls">
        <input
          className="palette-filter"
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {tab === 'services' && (
          <label className="svc-toggle">
            <input type="checkbox" checked={includeImpls} onChange={(e) => setIncludeImpls(e.target.checked)} />
            include impls
          </label>
        )}
      </div>

      {loading && <div className="muted small">loading…</div>}

      {tab === 'services' && (
        <ul className="svc-list">
          {services.length === 0 && <li className="muted small">no services match.</li>}
          {services.map((s) => <ServiceRow key={s.declaringType} s={s} />)}
        </ul>
      )}
      {tab === 'external' && (
        <ul className="svc-list">
          {externals.length === 0 && <li className="muted small">no external HTTP boundaries.</li>}
          {externals.map((b) => <BoundaryRow key={b.label} b={b} />)}
        </ul>
      )}
      {tab === 'database' && (
        <ul className="svc-list">
          {databases.length === 0 && <li className="muted small">no database boundaries.</li>}
          {databases.map((b) => <BoundaryRow key={b.label} b={b} />)}
        </ul>
      )}
    </div>
  );
}

function ServiceRow({ s }: { s: ServiceUsageEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`svc-row ${s.isInterface ? 'svc-iface' : 'svc-class'}`}>
      <div className="svc-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="svc-caret">{open ? '▾' : '▸'}</span>
        <span className="svc-kind">{s.isInterface ? 'interface' : 'class'}</span>
        <span className="svc-name">{s.shortName}</span>
        {s.resolvedImplType && (
          <span className="svc-impl">→ {shorten(s.resolvedImplType)}</span>
        )}
        <span className="svc-count" title={`${s.usedByEndpoints.length} endpoint(s) · ${s.totalCallSites} call sites`}>
          {s.usedByEndpoints.length} ep
        </span>
      </div>
      {open && (
        <div className="svc-row-body">
          <div className="svc-fqn">{s.declaringType}</div>
          {s.calledMethods.length > 0 && (
            <div className="svc-methods">
              <span className="muted small">methods: </span>
              {s.calledMethods.map((m) => <code key={m}>{m}</code>)}
            </div>
          )}
          <div className="svc-endpoints">
            <span className="muted small">used by: </span>
            {s.usedByEndpoints.map((e) => <code key={e}>{e}</code>)}
          </div>
        </div>
      )}
    </li>
  );
}

function BoundaryRow({ b }: { b: ExternalBoundary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`svc-row svc-${b.kind === 'ExternalHttp' ? 'http' : 'db'}`}>
      <div className="svc-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="svc-caret">{open ? '▾' : '▸'}</span>
        <span className="svc-kind">{b.kind === 'ExternalHttp' ? '→ external' : 'database'}</span>
        <span className="svc-name">{b.label}</span>
        <span className="svc-count">{b.usedByEndpoints.length} ep</span>
      </div>
      {open && (
        <div className="svc-row-body">
          <span className="muted small">used by: </span>
          {b.usedByEndpoints.map((e) => <code key={e}>{e}</code>)}
        </div>
      )}
    </li>
  );
}

function shorten(full: string): string {
  const dot = full.lastIndexOf('.');
  return dot < 0 ? full : full.substring(dot + 1);
}
