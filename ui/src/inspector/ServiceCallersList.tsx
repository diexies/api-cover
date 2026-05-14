import { useEffect, useMemo, useState } from 'react';
import {
  getMethodCallers,
  getServiceCallers,
  getServiceMap,
  type MethodCallersDto,
  type ServiceCallersDto,
  type ServiceMapNode,
} from '../api';
import { formatCallerRef } from './callRef';

interface Props {
  serviceId: string;
  /** When set, fetches the method-granular reverse index — only call sites that hit
   * `serviceId.methodName` are shown. Otherwise falls back to the service-wide view. */
  methodName?: string;
  onPickSource?: (filePath: string, line: number, endLine?: number) => void;
}

type Scope = 'method' | 'service';

/**
 * Reverse-fan-in panel. Two scopes:
 *   - method  → only the chosen method's call sites (precise; what an LLM wants before
 *               touching a method)
 *   - service → entire service rolled up (legacy view, used as a fallback)
 */
export function ServiceCallersList({ serviceId, methodName, onPickSource }: Props) {
  const initialScope: Scope = methodName ? 'method' : 'service';
  const [scope, setScope] = useState<Scope>(initialScope);
  useEffect(() => { setScope(methodName ? 'method' : 'service'); }, [methodName, serviceId]);

  const [methodDto, setMethodDto] = useState<MethodCallersDto | null | undefined>(methodName ? undefined : null);
  const [serviceDto, setServiceDto] = useState<ServiceCallersDto | null | undefined>(undefined);
  const [node, setNode] = useState<ServiceMapNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methodFilter, setMethodFilter] = useState<string>('__all__');

  useEffect(() => {
    let alive = true;
    setError(null);
    setServiceDto(undefined);
    setMethodFilter('__all__');
    if (methodName) setMethodDto(undefined); else setMethodDto(null);

    const tasks: Promise<unknown>[] = [
      getServiceCallers(serviceId).then((d) => { if (alive) setServiceDto(d); }),
      getServiceMap().then((m) => { if (alive) setNode(m?.nodes.find((n) => n.id === serviceId) ?? null); }),
    ];
    if (methodName) {
      tasks.push(getMethodCallers(serviceId, methodName).then((d) => { if (alive) setMethodDto(d); }));
    }
    Promise.allSettled(tasks).catch(() => { /* ignored; per-call setters already wrote */ });

    return () => { alive = false; };
  }, [serviceId, methodName]);

  const filteredCallerServices = useMemo(() => {
    if (!serviceDto) return [];
    if (methodFilter === '__all__') return serviceDto.callerServices;
    const allowedEndpoints = new Set(serviceDto.methodCallers[methodFilter] ?? []);
    return serviceDto.callerServices.filter((c) =>
      c.calledByEndpoints.some((e) => allowedEndpoints.has(e)),
    );
  }, [serviceDto, methodFilter]);

  if (serviceDto === undefined) return <div className="service-callers muted small">loading callers…</div>;
  if (error) return <div className="service-callers muted small">callers unavailable: {error}</div>;
  if (serviceDto === null) return <div className="service-callers muted small">No callers indexed for this service.</div>;

  const methodNames = Object.keys(serviceDto.methodCallers).sort();

  return (
    <div className="service-callers">
      <header className="service-callers-head">
        <div className="service-callers-title">
          <span className="service-callers-shortname">{serviceDto.shortName}</span>
          {methodName && <span className="service-callers-methodname">.{methodName}</span>}
          {serviceDto.isInterface && <span className="service-callers-tag">interface</span>}
          {serviceDto.resolvedImplType && (
            <span className="service-callers-impl" title={serviceDto.resolvedImplType}>
              → {serviceDto.resolvedImplType.split('.').pop()}
            </span>
          )}
        </div>
        {node && (
          <div className="service-callers-metrics">
            <Chip label="fan-in" value={node.metrics.fanIn} />
            <Chip label="fan-out" value={node.metrics.fanOut} />
            <Chip label="depth" value={node.metrics.depth} />
            <Chip label="coupling" value={Math.round(node.metrics.coupling)} />
            <Chip label="instability" value={node.metrics.instability == null ? '—' : node.metrics.instability.toFixed(2)} />
            <Chip label="endpoints" value={serviceDto.transitiveEndpointCount} />
          </div>
        )}
        {methodName && (
          <div className="service-callers-scope" role="tablist" aria-label="caller scope">
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'method'}
              className={`service-callers-scope-btn${scope === 'method' ? ' is-active' : ''}`}
              onClick={() => setScope('method')}
              title="Show only sites that hit this method"
            >This method <span className="service-callers-scope-count">{methodDto?.totalCallSites ?? 0}</span></button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'service'}
              className={`service-callers-scope-btn${scope === 'service' ? ' is-active' : ''}`}
              onClick={() => setScope('service')}
              title="Show every caller of the service"
            >Whole service <span className="service-callers-scope-count">{serviceDto.callerServices.length}</span></button>
          </div>
        )}
      </header>

      {scope === 'method' && methodName && (
        <MethodScopeView dto={methodDto} target={`${serviceDto.shortName}.${methodName}`} onPickSource={onPickSource} />
      )}

      {scope === 'service' && (
        <ServiceScopeView
          dto={serviceDto}
          methodNames={methodNames}
          methodFilter={methodFilter}
          setMethodFilter={setMethodFilter}
          filteredCallerServices={filteredCallerServices}
          onPickSource={onPickSource}
        />
      )}
    </div>
  );
}

function MethodScopeView({
  dto, target, onPickSource,
}: {
  dto: MethodCallersDto | null | undefined;
  target: string;
  onPickSource?: (filePath: string, line: number, endLine?: number) => void;
}) {
  if (dto === undefined) return <div className="service-callers-empty muted small">loading method callers…</div>;
  if (dto === null) {
    return <div className="service-callers-empty muted small">No callers indexed for <code>{target}</code>. Try "Whole service" above.</div>;
  }
  return (
    <>
      <section className="service-callers-section">
        <h4 className="service-callers-section-title">
          Call sites <span className="muted small">{dto.callSites.length}</span>
        </h4>
        {dto.callSites.length === 0 ? (
          <div className="service-callers-empty muted small">No call sites recorded for this method.</div>
        ) : (
          <ul className="service-callers-list">
            {dto.callSites.map((c) => {
              const noSource = !c.filePath || c.lineNumber == null;
              return (
                <li key={c.ref + '|' + (c.filePath ?? '?')}>
                  <button
                    type="button"
                    className={`service-callers-row${noSource ? ' is-no-source' : ''}`}
                    title={noSource ? 'No PDB — cannot jump to source' : c.filePath}
                    disabled={noSource}
                    onClick={() => {
                      if (noSource || !c.filePath || c.lineNumber == null) return;
                      onPickSource?.(c.filePath, c.lineNumber, c.endLine ?? undefined);
                    }}
                  >
                    <span className="service-callers-ref">{c.ref}</span>
                    {noSource && <span className="service-callers-badge">no PDB</span>}
                    {c.summary && <span className="service-callers-summary muted small">{c.summary}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="service-callers-section">
        <h4 className="service-callers-section-title">
          Endpoints reaching this method <span className="muted small">{dto.directCallers.length}</span>
        </h4>
        {dto.directCallers.length === 0 ? (
          <div className="service-callers-empty muted small">No endpoints transitively call this method.</div>
        ) : (
          <ul className="service-callers-endpoints">
            {dto.directCallers.map((e) => (
              <li key={e.endpointId}>
                <span className="service-callers-endpoint-id">{e.endpointId}</span>
                {e.via.length > 0 && (
                  <span className="service-callers-via muted small">
                    via {e.via.map((v) => v.split('.').pop()).join(' → ')}
                  </span>
                )}
                <span className="service-callers-callsites muted small">{e.callSites} sites</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="service-callers-section">
        <h4 className="service-callers-section-title">
          Calls (forward deps) <span className="muted small">{dto.callees.length}</span>
        </h4>
        {dto.callees.length === 0 ? (
          <div className="service-callers-empty muted small">No internal calls detected in this method's body.</div>
        ) : (
          <ul className="service-callers-list">
            {dto.callees.map((c) => {
              const noSource = !c.filePath || c.lineNumber == null;
              return (
                <li key={c.ref + '|' + (c.filePath ?? '?')}>
                  <button
                    type="button"
                    className={`service-callers-row${noSource ? ' is-no-source' : ''}`}
                    title={noSource ? `${c.kind}${c.filePath ? ' — ' + c.filePath : ' — no PDB'}` : c.filePath}
                    disabled={noSource}
                    onClick={() => {
                      if (noSource || !c.filePath || c.lineNumber == null) return;
                      onPickSource?.(c.filePath, c.lineNumber, c.endLine ?? undefined);
                    }}
                  >
                    <span className={`service-callers-kind kind-${c.kind.toLowerCase()}`}>{kindGlyph(c.kind)}</span>
                    <span className="service-callers-ref">{c.ref}</span>
                    {c.resolvedImplType && (
                      <span className="service-callers-impl muted small">→ {c.resolvedImplType.split('.').pop()}</span>
                    )}
                    {noSource && <span className="service-callers-badge">no PDB</span>}
                    {c.summary && <span className="service-callers-summary muted small">{c.summary}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case 'Interface': return 'I';
    case 'Method': return 'M';
    case 'ControllerMethod': return 'C';
    case 'ExternalHttp': return 'H';
    case 'Database': return 'D';
    case 'Cycle': return '↺';
    case 'DepthCap': return '…';
    case 'Dynamic': return '?';
    case 'Framework': return 'F';
    case 'Opaque': return '·';
    default: return '·';
  }
}

function ServiceScopeView({
  dto, methodNames, methodFilter, setMethodFilter, filteredCallerServices, onPickSource,
}: {
  dto: ServiceCallersDto;
  methodNames: string[];
  methodFilter: string;
  setMethodFilter: (v: string) => void;
  filteredCallerServices: ServiceCallersDto['callerServices'];
  onPickSource?: (filePath: string, line: number, endLine?: number) => void;
}) {
  return (
    <>
      {methodNames.length > 0 && (
        <div className="service-callers-filter">
          <label>
            <span className="muted small">method</span>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              aria-label="filter by method name"
            >
              <option value="__all__">All methods ({methodNames.length})</option>
              {methodNames.map((m) => (
                <option key={m} value={m}>
                  {m} ({(dto.methodCallers[m] ?? []).length})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <section className="service-callers-section">
        <h4 className="service-callers-section-title">
          Called by services <span className="muted small">{filteredCallerServices.length}</span>
        </h4>
        {filteredCallerServices.length === 0 ? (
          <div className="service-callers-empty muted small">No service-level callers.</div>
        ) : (
          <ul className="service-callers-list">
            {filteredCallerServices.map((c) => {
              const ref = formatCallerRef(c);
              const noSource = !c.filePath || c.lineNumber == null;
              return (
                <li key={c.id + ':' + (c.methodName ?? '?') + ':' + (c.lineNumber ?? '?')}>
                  <button
                    type="button"
                    className={`service-callers-row${noSource ? ' is-no-source' : ''}`}
                    title={noSource ? 'No PDB — cannot jump to source' : c.filePath ?? undefined}
                    disabled={noSource}
                    onClick={() => {
                      if (noSource || !c.filePath || c.lineNumber == null) return;
                      onPickSource?.(c.filePath, c.lineNumber, c.endLine ?? undefined);
                    }}
                  >
                    <span className="service-callers-ref">{ref}</span>
                    {noSource && <span className="service-callers-badge">no PDB</span>}
                    {c.summary && <span className="service-callers-summary muted small">{c.summary}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="service-callers-section">
        <h4 className="service-callers-section-title">
          Endpoints reaching this service <span className="muted small">{dto.directCallers.length}</span>
        </h4>
        {dto.directCallers.length === 0 ? (
          <div className="service-callers-empty muted small">No endpoints transitively call this service.</div>
        ) : (
          <ul className="service-callers-endpoints">
            {dto.directCallers.map((e) => (
              <li key={e.endpointId}>
                <span className="service-callers-endpoint-id">{e.endpointId}</span>
                {e.via.length > 0 && (
                  <span className="service-callers-via muted small">
                    via {e.via.map((v) => v.split('.').pop()).join(' → ')}
                  </span>
                )}
                <span className="service-callers-callsites muted small">{e.callSites} sites</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Chip({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="service-callers-chip">
      <span className="service-callers-chip-label">{label}</span>
      <span className="service-callers-chip-value">{value}</span>
    </div>
  );
}
