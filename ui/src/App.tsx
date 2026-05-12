import { useEffect, useMemo, useRef, useState } from 'react';
import { ScenarioCanvas } from './ScenarioCanvas';
import { ScenarioList } from './ScenarioList';
import { ServiceCatalogPanel } from './ServiceCatalogPanel';
import { EndpointPalette } from './EndpointPalette';
import { getAgentStatus, getInspectorOptions, getScenario, listEndpoints, listRuns, listScenarios, saveScenario, type AgentStatus, type EndpointDescriptor, type Run, type Scenario } from './api';
import { GlobalSettingsModal } from './GlobalSettingsModal';
import { NewScenarioControl } from './NewScenarioControl';
import { Dashboard } from './Dashboard';
import { loadAuth, saveAuth, type AuthConfig } from './auth';
import { useResizableWidth } from './useResizableWidth';
import { AgentPanel } from './AgentPanel';
import { ServiceMapPanel } from './inspector/ServiceMapPanel';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { coverage } from './home/utils';

type SidebarMode = 'scenarios' | 'endpoints' | 'services' | 'inspector';
type DashboardSection = 'home' | 'stats' | 'scenarios';

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
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [dashboardSection, setDashboardSection] = useState<DashboardSection>('home');
  // Agent panel only docks on the home dashboard — scenario canvas and
  // inspector own their own real estate. The home composer is the single
  // affordance for sending a prompt; no manual open/close button.
  const onHome = !selected && sidebar !== 'inspector' && dashboardSection === 'home';
  const agentDocked = !!agentStatus && onHome;
  // Composer hand-off: home composer drops a prompt here, AgentPanel reads it
  // on mount via initialPrompt + autoStart, then onPromptConsumed clears it.
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<string | null>(null);
  const [pendingAgentMode, setPendingAgentMode] = useState<string | null>(null);
  // Snapshot of scenario ids taken when a scenario-generation run starts, so we can
  // detect the newly-created scenario after the run completes and auto-select it.
  const knownScenarioIdsRef = useRef<Set<string>>(new Set());

  function openAgentWithPrompt(text: string, mode?: string | null) {
    if (mode === 'scenario') {
      knownScenarioIdsRef.current = new Set(scenarios.map((s) => s.id));
    }
    setPendingAgentPrompt(text);
    setPendingAgentMode(mode ?? null);
  }

  async function handleAgentRunCompleted(modeLabel: string | null) {
    if (modeLabel !== 'scenario' && modeLabel !== 'discover') return;
    if (modeLabel === 'discover') {
      try { localStorage.removeItem('apicover.idleDiscoverInflight'); } catch { /* quota */ }
    }
    try {
      const list = await listScenarios();
      setScenarios(list);
      const newOne = list.find((s) => !knownScenarioIdsRef.current.has(s.id));
      if (newOne) {
        setSelectedId(newOne.id);
        setSidebar('scenarios');
      }
      if (modeLabel === 'discover' && list.length > 0) {
        try { localStorage.setItem('apicover.idleDiscoverDismissed.v2', '1'); } catch { /* quota */ }
      }
    } catch {
      /* surface via existing error state on next reload; non-fatal */
    }
  }

  // Open the global settings modal, optionally pinning a specific tab. The
  // modal reads the active tab from localStorage on mount, so writing the
  // key first makes the open land where the caller intends.
  function openGlobalSettings(tab?: 'auth' | 'agent' | 'settings') {
    if (tab) {
      try { localStorage.setItem('apicover.settingsTab', tab); } catch { /* quota */ }
    }
    setGlobalSettingsOpen(true);
  }

  useEffect(() => {
    getInspectorOptions().then((o) => setEnableCallGraph(!!o.enableCallGraph)).catch(() => {});
  }, []);

  async function refreshAgentStatus() {
    const s = await getAgentStatus();
    setAgentStatus(s);
  }
  useEffect(() => { refreshAgentStatus(); }, []);
  const sidebarSize = useResizableWidth('utopia.sidebar.width', 380, 240, 640);

  useEffect(() => {
    refreshScenarios();
    listEndpoints().then(setEndpoints).catch((e: Error) => setError(e.message));
    listRuns().then(setRuns).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle-scan auto-discover: when the workspace is empty and the agent is ready,
  // fire one ScenarioInfer run so Claude inspects the API surface and seeds
  // scenarios without user input. Dismissed-once flag in localStorage prevents
  // re-firing across reloads (user can clear via /discover chip manually).
  const didIdleDiscoverRef = useRef(false);
  useEffect(() => {
    if (didIdleDiscoverRef.current) return;
    if (!onHome) return;
    if (scenarios.length > 0) return;
    if (!agentStatus) return;
    const ready = agentStatus.mode !== 'Disabled' && (agentStatus.mode === 'Max' || agentStatus.hasApiKey);
    if (!ready) return;
    let dismissed = false;
    let inflight = false;
    try {
      dismissed = localStorage.getItem('apicover.idleDiscoverDismissed.v2') === '1';
      // In-flight semaphore — survives reload during a long-running idle discover so
      // refreshing the page doesn't fire a second concurrent run. Stale entries older
      // than 15 minutes are ignored (assumes the previous run died without cleanup).
      const flightRaw = localStorage.getItem('apicover.idleDiscoverInflight');
      if (flightRaw) {
        const ts = Number(flightRaw);
        if (Number.isFinite(ts) && Date.now() - ts < 15 * 60_000) inflight = true;
      }
    } catch { /* quota */ }
    if (dismissed || inflight) return;
    didIdleDiscoverRef.current = true;
    knownScenarioIdsRef.current = new Set();
    try { localStorage.setItem('apicover.idleDiscoverInflight', String(Date.now())); } catch { /* quota */ }
    openAgentWithPrompt('Inspect this API and propose likely scenarios.', 'discover');
    // Persist dismiss only after run completes (in handleAgentRunCompleted), not now —
    // otherwise a failed/cancelled run leaves the user with no scenarios and no re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentStatus, scenarios.length, onHome]);

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

  // Build the global command palette: navigate to any scenario, create one, jump
  // into settings or specialty panels. Recomputed when scenarios/agent/feature flags change.
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [];
    for (const s of scenarios) {
      cmds.push({
        id: `open:${s.id}`,
        label: s.name || s.id,
        hint: `${s.nodes.length} node${s.nodes.length === 1 ? '' : 's'}`,
        group: 'flow',
        run: () => setSelectedId(s.id),
      });
    }
    cmds.push({
      id: 'go:dashboard',
      label: 'Open dashboard',
      group: 'nav',
      run: () => { setSelectedId(null); setSidebar('scenarios'); },
    });
    cmds.push({
      id: 'go:settings',
      label: 'Open global settings',
      group: 'nav',
      run: () => setGlobalSettingsOpen(true),
    });
    if (enableCallGraph) {
      cmds.push({
        id: 'go:inspector',
        label: 'Open system inspector',
        group: 'nav',
        run: () => { setSelectedId(null); setSidebar('inspector'); },
      });
      cmds.push({
        id: 'go:services',
        label: 'Open service catalog',
        group: 'nav',
        run: () => { setSelectedId(null); setSidebar('services'); },
      });
    }
    return cmds;
  }, [scenarios, enableCallGraph]);

  // Live workspace numbers — surfaced permanently in the top nav so the
  // user always knows where they stand without leaving the active screen.
  const cov = coverage(endpoints, scenarios);
  // Coverage tone drives the stats card's left rail colour, giving the bar a
  // colourful at-a-glance read of how covered the project actually is.
  const covTone = cov.pct >= 70 ? 'good' : cov.pct >= 30 ? 'warn' : 'bad';

  function gotoSection(section: DashboardSection) {
    setSelectedId(null);
    setSidebar('scenarios');
    setDashboardSection(section);
  }

  return (
    <div className="app">
      <header className="topnav" aria-label="workspace summary">
        <button
          type="button"
          className="topnav-brand"
          onClick={() => gotoSection('home')}
          title="Open dashboard"
        >
          <span className="topnav-brand-spark" aria-hidden="true">✦</span>
          <span className="topnav-brand-text">APICover</span>
        </button>
        <div className={`topnav-stats tone-${covTone}`} role="group" aria-label="workspace stats">
          <span className="topnav-stat stat-apis">
            <span className="topnav-stat-label">apis</span>
            <span className="topnav-stat-value">{endpoints.length}</span>
          </span>
          <span className="topnav-sep" aria-hidden="true">·</span>
          <span className="topnav-stat stat-scenarios">
            <span className="topnav-stat-label">scenarios</span>
            <span className="topnav-stat-value">{scenarios.length}</span>
          </span>
          <span className="topnav-sep" aria-hidden="true">·</span>
          <span className={`topnav-stat stat-coverage tone-${covTone}`}>
            <span className="topnav-stat-label">coverage</span>
            <span className="topnav-stat-value">{cov.pct}%</span>
          </span>
          <span className="topnav-sep" aria-hidden="true">·</span>
          <span className="topnav-stat stat-runs">
            <span className="topnav-stat-label">runs</span>
            <span className="topnav-stat-value">{runs.length}</span>
          </span>
        </div>
        <div className="topnav-tiles">
          <button
            type="button"
            className="topnav-tile is-icon tile-stats"
            onClick={() => gotoSection('stats')}
            title="Statistics"
            aria-label="statistics"
          >
            <span className="topnav-tile-icon" aria-hidden="true">◧</span>
          </button>
          <button
            type="button"
            className="topnav-tile is-icon tile-settings"
            onClick={() => setGlobalSettingsOpen(true)}
            title="Settings"
            aria-label="settings"
          >
            <span className="topnav-tile-icon" aria-hidden="true">⚙</span>
          </button>
        </div>
      </header>
      <div className={`layout${agentDocked ? ' is-agent-docked' : ''}${sidebar === 'inspector' ? ' is-fullbleed' : ''}`}>
        {sidebar !== 'inspector' && (
        <aside className="sidebar" style={{ width: sidebarSize.width }}>
          {sidebar === 'scenarios' && (
            <>
              <div className="sidebar-head">
                <h2>Business Flows</h2>
                <NewScenarioControl onCreate={createScenario} existingIds={scenarios.map((s) => s.id)} onError={setError} />
                {enableCallGraph && (
                  <>
                    <button className="settings-btn" title="System inspector" onClick={() => setSidebar('inspector')}>📡</button>
                    <button className="settings-btn" title="Service catalog" onClick={() => setSidebar('services')}>⛁</button>
                  </>
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
              agentStatus={agentStatus}
              onAgentChanged={refreshAgentStatus}
            />
          )}
        </aside>
        )}
        {sidebar !== 'inspector' && (
          <div
            className="resize-handle vertical"
            onMouseDown={(e) => sidebarSize.startResize(e, 'right')}
            title="Drag to resize sidebar"
          />
        )}
        <main className="content">
          {error && <div className="error banner">{error}</div>}
          {sidebar === 'inspector' && (
            <ServiceMapPanel onClose={() => setSidebar('scenarios')} />
          )}
          {sidebar !== 'inspector' && !selected && !error && (
            <Dashboard
              scenarios={scenarios}
              endpoints={endpoints}
              runs={runs}
              agentEnabled={agentDocked}
              agentStatus={agentStatus}
              auth={auth}
              section={dashboardSection}
              onSectionChange={setDashboardSection}
              onOpenGlobalSettings={(tab) => openGlobalSettings(tab)}
              onSendPrompt={openAgentWithPrompt}
            />
          )}
          {sidebar !== 'inspector' && selected && (
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
        {agentDocked && agentStatus && (
          <AgentPanel
            status={agentStatus}
            onOpenSettings={(tab) => openGlobalSettings(tab)}
            initialPrompt={pendingAgentPrompt ?? undefined}
            initialPromptMode={pendingAgentMode ?? undefined}
            autoStart={pendingAgentPrompt !== null}
            onPromptConsumed={() => { setPendingAgentPrompt(null); setPendingAgentMode(null); }}
            onStatusChanged={setAgentStatus}
            onRunCompleted={handleAgentRunCompleted}
          />
        )}
      </div>
      <CommandPalette commands={paletteCommands} />
    </div>
  );
}

export function normalisePath(p: string): string {
  // Strip route constraints like ":int" inside path segments: "/users/{id:int}" → "/users/{id}".
  return p.replace(/\{([^:}]+):[^}]+\}/g, '{$1}');
}
