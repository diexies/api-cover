import { useEffect, useMemo, useState } from 'react';
import { ScenarioCanvas } from './ScenarioCanvas';
import { ScenarioList } from './ScenarioList';
import { ServiceCatalogPanel } from './ServiceCatalogPanel';
import { EndpointPalette } from './EndpointPalette';
import { getInspectorOptions, getScenario, listEndpoints, listRuns, listScenarios, saveScenario, type EndpointDescriptor, type Run, type Scenario } from './api';
import { GlobalSettingsModal } from './GlobalSettingsModal';
import { NewScenarioControl } from './NewScenarioControl';
import { Dashboard } from './Dashboard';
import { loadAuth, saveAuth, type AuthConfig } from './auth';
import { useResizableWidth } from './useResizableWidth';

type SidebarMode = 'scenarios' | 'endpoints' | 'services';

const LAST_SCENARIO_KEY = 'apicover.lastScenarioId';

function readLastScenarioId(): string | null {
  try {
    const v = localStorage.getItem(LAST_SCENARIO_KEY);
    return v && v.length > 0 ? v : null;
  } catch { return null; }
}
function writeLastScenarioId(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_SCENARIO_KEY, id);
    else localStorage.removeItem(LAST_SCENARIO_KEY);
  } catch { /* storage disabled / quota — ignore */ }
}

export function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  // Restore last open scenario from localStorage so reload lands the user back
  // on the flow they were editing instead of dumping them on the dashboard.
  const [selectedId, setSelectedId] = useState<string | null>(() => readLastScenarioId());
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<SidebarMode>('scenarios');
  const [endpoints, setEndpoints] = useState<EndpointDescriptor[]>([]);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [auth, setAuth] = useState<AuthConfig>(() => loadAuth());
  const [enableCallGraph, setEnableCallGraph] = useState(false);

  useEffect(() => {
    getInspectorOptions().then((o) => setEnableCallGraph(!!o.enableCallGraph)).catch(() => {});
  }, []);
  const sidebarSize = useResizableWidth('utopia.sidebar.width', 380, 240, 640);

  useEffect(() => {
    refreshScenarios();
    listEndpoints().then(setEndpoints).catch((e: Error) => setError(e.message));
    listRuns().then(setRuns).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    writeLastScenarioId(selectedId);
    if (!selectedId) { setSelected(null); setSidebar('scenarios'); return; }
    getScenario(selectedId)
      .then((s) => { setSelected(s); setSidebar('endpoints'); })
      .catch((e: Error) => {
        // Persisted ID is stale (scenario deleted out-of-band). Clear it and
        // fall back to dashboard rather than wedging the user on an error.
        writeLastScenarioId(null);
        setSelectedId(null);
        setSelected(null);
        setSidebar('scenarios');
        setError(e.message);
      });
  }, [selectedId]);

  // Lookup map: METHOD path → descriptor. Path constraints (e.g. "{id:int}") are normalised
  // to "{id}" so node paths set by the user resolve to the underlying endpoint.
  const endpointLookup = useMemo(() => {
    const m = new Map<string, EndpointDescriptor>();
    for (const ep of endpoints) {
      const key = `${ep.method.toUpperCase()} ${normalisePath(ep.path)}`;
      m.set(key, ep);
    }
    return m;
  }, [endpoints]);

  // Cross-scenario index: which scenarios reference each (METHOD path) endpoint.
  const scenariosUsingEndpoint = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const s of scenarios) {
      for (const n of s.nodes) {
        const key = `${n.method.toUpperCase()} ${normalisePath(n.path)}`;
        const arr = m.get(key) ?? [];
        if (!arr.some((x) => x.id === s.id)) arr.push({ id: s.id, name: s.name });
        m.set(key, arr);
      }
    }
    return m;
  }, [scenarios]);

  // Per (METHOD path) and per scenario: pass/fail tallies derived from runs.
  const endpointStatsByKey = useMemo(() => {
    type Stat = { passed: number; failed: number; perScenario: Map<string, { passed: number; failed: number }> };
    const m = new Map<string, Stat>();
    const scnIndex = new Map(scenarios.map((s) => [s.id, s]));
    for (const r of runs) {
      const scn = scnIndex.get(r.scenarioId);
      if (!scn) continue;
      for (const res of r.nodeResults ?? []) {
        const node = scn.nodes.find((n) => n.id === res.nodeId);
        if (!node) continue;
        const key = `${node.method.toUpperCase()} ${normalisePath(node.path)}`;
        const stat = m.get(key) ?? { passed: 0, failed: 0, perScenario: new Map() };
        const per = stat.perScenario.get(scn.id) ?? { passed: 0, failed: 0 };
        if (res.status === 'succeeded') { stat.passed++; per.passed++; }
        else if (res.status === 'failed') { stat.failed++; per.failed++; }
        stat.perScenario.set(scn.id, per);
        m.set(key, stat);
      }
    }
    return m;
  }, [runs, scenarios]);

  async function refreshScenarios() {
    try {
      const list = await listScenarios();
      setScenarios(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function onScenarioSaved(s: Scenario) {
    setSelected(s);
    setScenarios((cur) => cur.map((x) => (x.id === s.id ? s : x)));
  }

  async function createScenario(rawId: string) {
    const id = rawId.trim();
    if (!id) return;
    if (scenarios.some((s) => s.id === id)) {
      setError(`scenario "${id}" already exists`);
      return;
    }
    const fresh: Scenario = { id, name: id, nodes: [], edges: [] };
    try {
      await saveScenario(fresh);
      setScenarios((cur) => [...cur, fresh]);
      setSelectedId(id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function backToScenarios() {
    setSelectedId(null);
    setSelected(null);
    setSidebar('scenarios');
  }

  const totalNodes = scenarios.reduce((acc, s) => acc + s.nodes.length, 0);
  // Tone: 'good' green, 'warn' orange, 'bad' red. Coverage-style ratios feed the colour;
  // raw-count items are neutral-good unless empty.
  type Tone = 'good' | 'warn' | 'bad';
  const apiCovered = endpoints.length; // placeholder: real coverage when wired up
  const apiTotal = endpoints.length;
  const scnRun = scenarios.length;
  const scnTotal = scenarios.length;

  function ratioTone(part: number, total: number): Tone {
    if (total === 0) return 'bad';
    const pct = part / total;
    if (pct >= 0.7) return 'good';
    if (pct >= 0.3) return 'warn';
    return 'bad';
  }
  function countTone(n: number): Tone { return n > 0 ? 'good' : 'bad'; }

  const stats: { label: string; value: string; tone: Tone }[] = [
    { label: 'project', value: '1', tone: 'good' },
    { label: 'apis', value: `${apiCovered}/${apiTotal}`, tone: ratioTone(apiCovered, apiTotal) },
    { label: 'scenarios', value: `${scnRun}/${scnTotal}`, tone: ratioTone(scnRun, scnTotal) },
    { label: 'nodes', value: `${totalNodes}`, tone: countTone(totalNodes) },
  ];

  return (
    <div className="app">
      {!selected && (
        <header className="centered-header">
          <ul className="header-stats">
            {stats.map((s) => (
              <li key={s.label}>
                <span className={`hs-dot tone-${s.tone}`} />
                <span className="hs-value">{s.value}</span>
                <span className="hs-label">{s.label}</span>
              </li>
            ))}
          </ul>
        </header>
      )}
      <div className="layout">
        <aside className="sidebar" style={{ width: sidebarSize.width }}>
          {sidebar === 'scenarios' && (
            <>
              <div className="sidebar-head">
                <h2>Business Flows</h2>
                <NewScenarioControl onCreate={createScenario} existingIds={scenarios.map((s) => s.id)} onError={setError} />
                {enableCallGraph && (
                  <button className="settings-btn" title="Service catalog" onClick={() => setSidebar('services')}>⛁</button>
                )}
              </div>
              <ScenarioList scenarios={scenarios} selectedId={selectedId} onSelect={setSelectedId} />
            </>
          )}
          {sidebar === 'endpoints' && selected && (
            <>
              <div className="sidebar-head back-row">
                <button className="back-arrow" onClick={backToScenarios} title="Back to scenarios">←</button>
                <span className="current-scenario">{selected.name}</span>
                <button className="settings-btn" title="Global settings" onClick={() => setGlobalSettingsOpen(true)}>⚙</button>
              </div>
              <EndpointPalette onError={setError} />
            </>
          )}
          {sidebar === 'services' && (
            <>
              <div className="sidebar-head">
                <h2>Services</h2>
                <button className="back-arrow" onClick={() => setSidebar('scenarios')} title="Back">←</button>
              </div>
              <ServiceCatalogPanel onError={setError} />
            </>
          )}
          {globalSettingsOpen && (
            <GlobalSettingsModal
              initialAuth={auth}
              onSaveAuth={(cfg) => { setAuth(cfg); saveAuth(cfg); }}
              onClose={() => setGlobalSettingsOpen(false)}
            />
          )}
        </aside>
        <div
          className="resize-handle vertical"
          onMouseDown={(e) => sidebarSize.startResize(e, 'right')}
          title="Drag to resize sidebar"
        />
        <main className="content">
          {error && <div className="error banner">{error}</div>}
          {!selected && !error && (
            <Dashboard
              scenarios={scenarios}
              endpoints={endpoints}
              runs={runs}
              onOpenGlobalSettings={() => setGlobalSettingsOpen(true)}
            />
          )}
          {selected && (
            <ScenarioCanvas
              scenario={selected}
              endpointLookup={endpointLookup}
              scenariosUsingEndpoint={scenariosUsingEndpoint}
              endpointStatsByKey={endpointStatsByKey}
              auth={auth}
              enableCallGraph={enableCallGraph}
              onSaved={onScenarioSaved}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function normalisePath(p: string): string {
  // Strip route constraints like ":int" inside path segments: "/users/{id:int}" → "/users/{id}".
  return p.replace(/\{([^:}]+):[^}]+\}/g, '{$1}');
}
