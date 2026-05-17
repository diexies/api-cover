import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentStatus, EndpointDescriptor, GitCommit, Run, RunStatus, Scenario, ServiceMap,
} from './api';
import { getGitLog, getServiceMap } from './api';
import type { AuthConfig } from './auth';
import { ChatComposer } from './home/ChatComposer';
import { CapabilityChips } from './home/CapabilityChips';
import { GitTimeline } from './home/GitTimeline';
import { coverage, relativeTime } from './home/utils';
import { usePrefs } from './stores/prefs';

type Section = 'home' | 'stats' | 'scenarios';

interface Props {
  scenarios: Scenario[];
  endpoints: EndpointDescriptor[];
  runs: Run[];
  onOpenGlobalSettings: (tab?: 'auth' | 'agent' | 'settings') => void;
  /** True when the agent backend is reachable + configured. Hides chat surface when false. */
  agentEnabled: boolean;
  /** Raw agent status — drives workspace warnings ("AI not configured"). */
  agentStatus: AgentStatus | null;
  /** Current global auth config — drives the "global auth not set" warning. */
  auth: AuthConfig;
  /** Send a prompt to the AgentPanel and auto-start a run. */
  onSendPrompt: (text: string, mode?: string | null) => void;
  /** Controlled section — App owns the state so the topnav can drive it. */
  section: Section;
  onSectionChange: (section: Section) => void;
}

/**
 * Workspace landing. Chat-first home composes ChatComposer + CapabilityChips +
 * RecentSessions + CompactStatsRow. Stats and Scenarios
 * detail views still swap into this same shell on demand.
 */
export function Dashboard({
  scenarios, endpoints, runs,
  onOpenGlobalSettings,
  agentEnabled,
  agentStatus,
  auth,
  onSendPrompt,
  section,
  onSectionChange,
}: Props) {
  return (
    <div className="dash2">
      {section === 'home' && (
        <HomeSection
          endpoints={endpoints}
          scenarios={scenarios}
          agentEnabled={agentEnabled}
          agentStatus={agentStatus}
          auth={auth}
          onOpenGlobalSettings={onOpenGlobalSettings}
          onSendPrompt={onSendPrompt}
        />
      )}
      {section === 'stats' && (
        <StatsSection
          onBack={() => onSectionChange('home')}
          endpoints={endpoints}
          scenarios={scenarios}
          runs={runs}
        />
      )}
      {section === 'scenarios' && (
        <ScenariosSection
          onBack={() => onSectionChange('home')}
          scenarios={scenarios}
          runs={runs}
        />
      )}
    </div>
  );
}

interface HomeSectionProps {
  endpoints: EndpointDescriptor[];
  scenarios: Scenario[];
  agentEnabled: boolean;
  agentStatus: AgentStatus | null;
  auth: AuthConfig;
  onOpenGlobalSettings: (tab?: 'auth' | 'agent' | 'settings') => void;
  onSendPrompt: (text: string, mode?: string | null) => void;
}

const KNOWN_MODES = new Set(['scenario', 'discover', 'scan', 'explain', 'map']);

function HomeSection({
  endpoints, scenarios, agentEnabled, agentStatus, auth,
  onOpenGlobalSettings,
  onSendPrompt,
}: HomeSectionProps) {
  const isFirstRun = scenarios.length === 0;
  const [draft, setDraft] = useState<string>(() => readDraft());
  // Mode chip: when set, renders inside the composer as a label and the typed
  // draft is the prompt body. Detected from a leading `/word ` typed manually
  // or chosen from CapabilityChips.
  const [mode, setMode] = useState<string | null>(null);

  // Persist composer draft so a refresh doesn't lose the half-typed thought.
  function handleDraftChange(v: string) {
    // If user typed `/word ` at the start and there's no mode yet, lift the
    // command into the chip so the textarea only shows the prompt body.
    if (mode === null && v.startsWith('/')) {
      const m = v.match(/^\/([a-z][a-z0-9-]*)(\s|$)/i);
      if (m) {
        const word = m[1].toLowerCase();
        if (KNOWN_MODES.has(word)) {
          setMode(word);
          const rest = v.slice(m[0].length);
          setDraft(rest);
          usePrefs.getState().set('chatDraft', rest);
          return;
        }
      }
    }
    setDraft(v);
    usePrefs.getState().set('chatDraft', v);
  }
  function handleSubmit(text: string) {
    const t = text.trim();
    if (!t) return;
    usePrefs.getState().set('chatDraft', '');
    setDraft('');
    const sent = mode;
    setMode(null);
    onSendPrompt(t, sent);
  }
  function handlePickCommand(token: string) {
    // Slash token from CapabilityChips → set mode chip; don't pollute the draft
    // with the literal `/scenario` prefix.
    const word = token.replace(/^\//, '').toLowerCase();
    setMode(word);
  }
  function handleClearMode() { setMode(null); }

  // Detect setup gaps and surface them as a warning popover next to the
  // search-hint. Each warning carries a title + body and (optionally) an
  // action that jumps the user to the right settings tab.
  const warnings: Warning[] = [];
  if (auth.type === 'none') {
    warnings.push({
      id: 'auth',
      title: 'Global auth not configured',
      message: 'Scenario runs go out unauthenticated. Set bearer / API key / basic credentials so flows that need a token actually work.',
      actionLabel: 'open settings',
      actionTab: 'auth',
    });
  }
  if (!agentStatus) {
    warnings.push({
      id: 'agent-missing',
      title: 'Claude agent unavailable',
      message: 'The embedded agent module isn’t mounted by the host. Add APICover.Agent + AddAgent() in Program.cs to enable AI features.',
    });
  } else if (agentStatus.mode === 'Disabled') {
    warnings.push({
      id: 'agent-disabled',
      title: 'AI mode disabled — scenarios cannot be generated',
      message: 'Auto-discovery, /scenario and /discover all need credentials. Pick "Max" (subscription detected) or paste an API key in agent settings.',
      actionLabel: 'open settings',
      actionTab: 'agent',
    });
  } else if (agentStatus.mode === 'ApiKey' && !agentStatus.hasApiKey) {
    warnings.push({
      id: 'agent-key-missing',
      title: 'Anthropic API key missing — scenarios cannot be generated',
      message: 'Agent is set to API key mode but no key is saved yet. Paste a key into Agent settings to unblock /scenario, /discover and auto-discovery.',
      actionLabel: 'open settings',
      actionTab: 'agent',
    });
  }

  return (
    <>
      <div className="home-hint-row">
        <div className="home-hint" aria-hidden="true">
          Press <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>+<kbd>K</kbd> to search anywhere
        </div>
        {warnings.length > 0 && (
          <WorkspaceWarnings
            warnings={warnings}
            onAction={onOpenGlobalSettings}
          />
        )}
      </div>

      {isFirstRun && (
        <FirstRunChecklist
          endpoints={endpoints}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      )}

      {(() => {
        const blocker = warnings.find((w) =>
          w.id === 'agent-disabled' || w.id === 'agent-key-missing' || w.id === 'agent-missing'
        );
        if (!blocker) return null;
        return (
          <div className="home-blocker-banner" role="alert">
            <span className="home-blocker-icon" aria-hidden="true">⚠</span>
            <div className="home-blocker-body">
              <div className="home-blocker-title">{blocker.title}</div>
              <div className="home-blocker-msg">{blocker.message}</div>
            </div>
            {blocker.actionLabel && blocker.actionTab && (
              <button
                type="button"
                className="home-blocker-action"
                onClick={() => onOpenGlobalSettings(blocker.actionTab)}
              >
                {blocker.actionLabel}
              </button>
            )}
          </div>
        );
      })()}

      {agentEnabled && (
        <>
          <div className="home-prompt-stack">
            <ChatComposer
              value={draft}
              onChange={handleDraftChange}
              onSubmit={handleSubmit}
              placeholder="Build a flow, ask a question…"
              mode={mode}
              onClearMode={handleClearMode}
            />
            <CapabilityChips onPick={handlePickCommand} />
          </div>
          <GitTimeline onSendPrompt={onSendPrompt} />
        </>
      )}
    </>
  );
}

function readDraft(): string {
  return usePrefs.getState().chatDraft;
}

/**
 * First-run onboarding strip: three sequential steps. Each step ticks off as the
 * underlying state is satisfied so a brand-new user has a single linear path from
 * "I just installed this" to "I have a working scenario".
 */
function FirstRunChecklist({
  endpoints,
  onOpenGlobalSettings,
}: {
  endpoints: EndpointDescriptor[];
  onOpenGlobalSettings: (tab?: 'auth' | 'agent' | 'settings') => void;
}) {
  const apiReady = endpoints.length > 0;

  const steps: { done: boolean; title: string; hint: string; action?: () => void; actionLabel?: string }[] = [
    {
      done: apiReady,
      title: 'Connect your API',
      hint: apiReady
        ? `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} discovered from the live route table.`
        : 'Add `app.UseAPICover()` to your ASP.NET host. Refresh once the app is running.',
    },
    {
      done: false,
      title: 'Create your first flow',
      hint: 'Use the “new flow” control in the sidebar. Name it after a business behavior — e.g. checkout, signup.',
    },
    {
      done: false,
      title: 'Add credentials (optional)',
      hint: 'If endpoints require auth, configure global credentials so every flow inherits them.',
      action: onOpenGlobalSettings,
      actionLabel: 'open settings',
    },
  ];

  return (
    <ol className="first-run-checklist" aria-label="getting started">
      {steps.map((step, i) => (
        <li key={i} className={`first-run-step ${step.done ? 'is-done' : ''}`}>
          <span className="first-run-num" aria-hidden="true">
            {step.done ? '✓' : i + 1}
          </span>
          <div className="first-run-body">
            <div className="first-run-title">{step.title}</div>
            <div className="first-run-hint">{step.hint}</div>
            {step.action && (
              <button type="button" className="first-run-action" onClick={step.action}>
                {step.actionLabel}
              </button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function durationMs(r: Run): number | null {
  if (!r.startedAt || !r.completedAt) return null;
  const a = new Date(r.startedAt).getTime();
  const b = new Date(r.completedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

function StatsSection({ onBack, endpoints, scenarios, runs }: {
  onBack: () => void;
  endpoints: EndpointDescriptor[]; scenarios: Scenario[]; runs: Run[];
}) {
  const cov = useMemo(() => coverage(endpoints, scenarios), [endpoints, scenarios]);

  const runsSorted = useMemo(
    () => [...runs].sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : -Infinity;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : -Infinity;
      return tb - ta;
    }),
    [runs],
  );

  const runsByScenario = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runsSorted) {
      const arr = m.get(r.scenarioId);
      if (arr) arr.push(r); else m.set(r.scenarioId, [r]);
    }
    return m;
  }, [runsSorted]);

  const aggregates = useMemo(() => {
    const now = Date.now();
    let succeeded = 0, failed = 0, today = 0, thisWeek = 0;
    const durations: number[] = [];
    for (const r of runs) {
      if (r.status === 'succeeded') succeeded++;
      else if (r.status === 'failed') failed++;
      if (r.startedAt) {
        const t = new Date(r.startedAt).getTime();
        if (!Number.isNaN(t)) {
          if (now - t < DAY_MS) today++;
          if (now - t < WEEK_MS) thisWeek++;
        }
      }
      const d = durationMs(r);
      if (d != null) durations.push(d);
    }
    const avgDuration = durations.length === 0
      ? null
      : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const avgNodes = scenarios.length === 0
      ? 0
      : Math.round(scenarios.reduce((sum, s) => sum + s.nodes.length, 0) / scenarios.length);
    return { succeeded, failed, today, thisWeek, avgDuration, avgNodes };
  }, [runs, scenarios]);

  const methodBuckets = useMemo(() => {
    const order = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const counts: Record<string, number> = { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0, OTHER: 0 };
    for (const ep of endpoints) {
      const m = (ep.method || '').toUpperCase();
      if (order.includes(m)) counts[m]++;
      else counts.OTHER++;
    }
    const total = endpoints.length || 1;
    return [...order, 'OTHER'].map((m) => ({
      method: m,
      count: counts[m],
      pct: Math.round((counts[m] / total) * 100),
    }));
  }, [endpoints]);

  const areaRows = useMemo(() => {
    const m = new Map<string, number>();
    for (const ep of endpoints) {
      const key = ep.area?.trim() || 'uncategorised';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    const max = Math.max(1, ...m.values());
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([area, count]) => ({ area, count, pct: Math.round((count / max) * 100) }));
  }, [endpoints]);

  const deprecated = useMemo(() => endpoints.filter((e) => e.isDeprecated), [endpoints]);
  const uncategorised = useMemo(
    () => endpoints.filter((e) => !e.area && !e.purpose),
    [endpoints],
  );

  const templates = useMemo(() => {
    return scenarios
      .map((s) => {
        const rs = runsByScenario.get(s.id) ?? [];
        const last = rs[0];
        const ok = rs.filter((r) => r.status === 'succeeded').length;
        const recent = rs.slice(0, 10).map((r) => r.status);
        return {
          scenario: s,
          runCount: rs.length,
          successRate: rs.length === 0 ? null : Math.round((ok / rs.length) * 100),
          lastRun: last ?? null,
          recentStatuses: recent,
        };
      })
      .sort((a, b) => {
        const ta = a.lastRun?.startedAt ? new Date(a.lastRun.startedAt).getTime() : -Infinity;
        const tb = b.lastRun?.startedAt ? new Date(b.lastRun.startedAt).getTime() : -Infinity;
        return tb - ta;
      });
  }, [scenarios, runsByScenario]);

  const activity = useMemo(() => runsSorted.slice(0, 30), [runsSorted]);

  const scenarioName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of scenarios) m.set(s.id, s.name);
    return m;
  }, [scenarios]);

  const subTotals = useMemo(() => {
    const samples = endpoints.reduce((acc, e) => acc + (e.samples?.length ?? 0), 0);
    const params = endpoints.reduce((acc, e) => acc + (e.parameters?.length ?? 0), 0);
    const responses = endpoints.reduce((acc, e) => acc + (e.responses?.length ?? 0), 0);
    let mutations = 0, breakpoints = 0, caseVariants = 0, groupsCount = 0, edgesCount = 0;
    for (const s of scenarios) {
      groupsCount += s.groups?.length ?? 0;
      edgesCount += s.edges?.length ?? 0;
      breakpoints += s.breakpoints?.length ?? 0;
      for (const g of s.groups ?? []) mutations += g.mutations?.length ?? 0;
      for (const c of s.caseSets ?? []) caseVariants += c.variants.length;
    }
    return { samples, params, responses, mutations, breakpoints, caseVariants, groupsCount, edgesCount };
  }, [endpoints, scenarios]);

  return (
    <div className="stats-page">
      <SectionHead title="Statistics" onBack={onBack} />

      <KpiGrid endpoints={endpoints} scenarios={scenarios} runs={runs} coverage={cov} aggregates={aggregates} deprecatedCount={deprecated.length} />

      <MethodBreakdown buckets={methodBuckets} />

      <AreaHistogram rows={areaRows} />

      <DeprecatedAndUncategorised deprecated={deprecated} uncategorised={uncategorised} />

      <TemplateGrid templates={templates} />

      <ActivityTimeline runs={activity} aggregates={aggregates} totalRuns={runs.length} scenarioName={scenarioName} />

      <SystemTopology />

      <RecentCommits />

      <SubTotalsFooter subTotals={subTotals} scenarios={scenarios.length} endpoints={endpoints.length} />
    </div>
  );
}

function StatsBlock({ title, hint, children, className }: {
  title: string; hint?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`stats-block ${className ?? ''}`}>
      <header className="stats-block-head">
        <h3>{title}</h3>
        {hint && <span className="stats-block-hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function KpiGrid({ endpoints, scenarios, runs, coverage: cov, aggregates, deprecatedCount }: {
  endpoints: EndpointDescriptor[]; scenarios: Scenario[]; runs: Run[];
  coverage: { covered: number; uncovered: number; pct: number };
  aggregates: { succeeded: number; failed: number; today: number; thisWeek: number; avgDuration: number | null; avgNodes: number };
  deprecatedCount: number;
}) {
  const covTone: 'good' | 'warn' | 'bad' = cov.pct >= 70 ? 'good' : cov.pct >= 30 ? 'warn' : 'bad';
  return (
    <StatsBlock title="Headline" hint="Workspace at a glance">
      <div className="kpi-grid-wide">
        <Kpi label="APIs" value={endpoints.length} />
        <Kpi label="Scenarios" value={scenarios.length} />
        <Kpi label="Runs total" value={runs.length} />
        <Kpi label="Coverage" value={`${cov.pct}%`} hint={`${cov.covered}/${endpoints.length}`} tone={covTone} />
        <Kpi label="Covered" value={cov.covered} tone="good" />
        <Kpi label="Untested" value={cov.uncovered} tone={cov.uncovered === 0 ? 'good' : 'warn'} />
        <Kpi label="Succeeded" value={aggregates.succeeded} tone="good" />
        <Kpi label="Failed" value={aggregates.failed} tone={aggregates.failed === 0 ? 'default' : 'bad'} />
        <Kpi label="Runs today" value={aggregates.today} hint={`${aggregates.thisWeek} this week`} />
        <Kpi label="Avg duration" value={fmtMs(aggregates.avgDuration)} />
        <Kpi label="Avg nodes / scn" value={aggregates.avgNodes} />
        <Kpi label="Deprecated" value={deprecatedCount} tone={deprecatedCount === 0 ? 'default' : 'warn'} />
      </div>
    </StatsBlock>
  );
}

function MethodBreakdown({ buckets }: { buckets: { method: string; count: number; pct: number }[] }) {
  return (
    <StatsBlock title="HTTP methods" hint="Endpoint count per verb">
      <div className="method-tile-grid">
        {buckets.map((b) => (
          <div key={b.method} className={`method-tile method-${b.method.toLowerCase()}`}>
            <div className="method-tile-head">
              <span className={`method-badge mb-${b.method.toLowerCase()}`}>{b.method}</span>
              <span className="method-tile-count">{b.count}</span>
            </div>
            <MiniBar pct={b.pct} variant={b.method.toLowerCase()} />
            <div className="method-tile-pct">{b.pct}%</div>
          </div>
        ))}
      </div>
    </StatsBlock>
  );
}

function AreaHistogram({ rows }: { rows: { area: string; count: number; pct: number }[] }) {
  return (
    <StatsBlock title="Endpoints by area" hint={`${rows.length} ${rows.length === 1 ? 'area' : 'areas'}`}>
      {rows.length === 0 ? (
        <div className="stats-empty">no endpoints discovered</div>
      ) : (
        <div className="area-histogram">
          {rows.map((r) => (
            <div key={r.area} className="area-histogram-row">
              <div className="area-name">{r.area}</div>
              <div className="area-bar"><div className="area-bar-fill" style={{ width: `${r.pct}%` }} /></div>
              <div className="area-count">{r.count}</div>
            </div>
          ))}
        </div>
      )}
    </StatsBlock>
  );
}

function DeprecatedAndUncategorised({ deprecated, uncategorised }: {
  deprecated: EndpointDescriptor[]; uncategorised: EndpointDescriptor[];
}) {
  return (
    <div className="stats-flag-grid">
      <StatsBlock title="Deprecated" hint={`${deprecated.length} flagged`} className="deprecated-block">
        {deprecated.length === 0 ? (
          <div className="stats-empty">nothing deprecated — clean slate</div>
        ) : (
          <ul className="flagged-list">
            {deprecated.map((ep) => (
              <li key={ep.id} className="flagged-row">
                <span className={`method-badge mb-${(ep.method || '').toLowerCase()}`}>{ep.method}</span>
                <span className="flagged-path">{ep.path}</span>
              </li>
            ))}
          </ul>
        )}
      </StatsBlock>
      <StatsBlock title="Uncategorised" hint={`${uncategorised.length} need area or purpose`} className="uncategorised-block">
        {uncategorised.length === 0 ? (
          <div className="stats-empty">every endpoint has an area or purpose</div>
        ) : (
          <ul className="flagged-list">
            {uncategorised.map((ep) => (
              <li key={ep.id} className="flagged-row">
                <span className={`method-badge mb-${(ep.method || '').toLowerCase()}`}>{ep.method}</span>
                <span className="flagged-path">{ep.path}</span>
              </li>
            ))}
          </ul>
        )}
      </StatsBlock>
    </div>
  );
}

function TemplateGrid({ templates }: {
  templates: {
    scenario: Scenario;
    runCount: number;
    successRate: number | null;
    lastRun: Run | null;
    recentStatuses: RunStatus[];
  }[];
}) {
  return (
    <StatsBlock title="Scenario templates" hint={`${templates.length} total · sorted by last run`}>
      {templates.length === 0 ? (
        <div className="stats-empty">no scenarios yet</div>
      ) : (
        <div className="template-grid">
          {templates.map(({ scenario: s, runCount, successRate, lastRun, recentStatuses }) => (
            <article key={s.id} className="template-card-v2">
              <header className="template-card-head">
                <div className="template-card-name">{s.name}</div>
                {lastRun ? <StatusPill status={lastRun.status} /> : <span className="status-pill status-pending">never run</span>}
              </header>
              {s.description && <div className="template-card-desc">{s.description}</div>}
              {(s.tags && s.tags.length > 0) && (
                <div className="template-card-tags">
                  {s.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
                </div>
              )}
              <div className="template-meta-grid">
                <div><span className="muted">nodes</span><b>{s.nodes.length}</b></div>
                <div><span className="muted">edges</span><b>{s.edges?.length ?? 0}</b></div>
                <div><span className="muted">groups</span><b>{s.groups?.length ?? 0}</b></div>
                <div><span className="muted">cases</span><b>{s.caseSets?.length ?? 0}</b></div>
                <div><span className="muted">runs</span><b>{runCount}</b></div>
                <div>
                  <span className="muted">success</span>
                  <b>{successRate == null ? '—' : `${successRate}%`}</b>
                </div>
              </div>
              <div className="template-card-foot">
                <DotStrip statuses={recentStatuses} />
                <span className="muted small">{lastRun ? relativeTime(lastRun.startedAt) : 'no history'}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </StatsBlock>
  );
}

function ActivityTimeline({ runs, aggregates, totalRuns, scenarioName }: {
  runs: Run[];
  aggregates: { succeeded: number; failed: number; today: number; thisWeek: number };
  totalRuns: number;
  scenarioName: Map<string, string>;
}) {
  return (
    <StatsBlock title="Recent run activity" hint={`last ${runs.length} of ${totalRuns}`}>
      <div className="activity-aggregate-strip">
        <span><b>{aggregates.today}</b> today</span>
        <span><b>{aggregates.thisWeek}</b> this week</span>
        <span><b>{aggregates.succeeded}</b> succeeded</span>
        <span><b>{aggregates.failed}</b> failed</span>
      </div>
      {runs.length === 0 ? (
        <div className="stats-empty">no runs recorded yet</div>
      ) : (
        <ul className="activity-list">
          {runs.map((r) => (
            <li key={r.id} className="activity-row">
              <span className="activity-scenario">{scenarioName.get(r.scenarioId) ?? r.scenarioId}</span>
              <StatusPill status={r.status} />
              <span className="activity-time">{relativeTime(r.startedAt)}</span>
              <span className="activity-duration">{fmtMs(durationMs(r))}</span>
              <span className="activity-error" title={r.error ?? ''}>{r.error ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </StatsBlock>
  );
}

function SystemTopology() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'empty' | 'error'; map: ServiceMap | null; error?: string }>(
    { status: 'loading', map: null },
  );
  useEffect(() => {
    let abort = false;
    getServiceMap().then((m) => {
      if (abort) return;
      if (!m) { setState({ status: 'empty', map: null }); return; }
      setState({ status: 'ready', map: m });
    }).catch((e) => {
      if (abort) return;
      setState({ status: 'error', map: null, error: String(e?.message ?? e) });
    });
    return () => { abort = true; };
  }, []);

  const summary = useMemo(() => {
    if (!state.map) return null;
    const kinds: Record<string, number> = { endpoint: 0, service: 0, externalHttp: 0, database: 0 };
    let depthSum = 0, depthCount = 0;
    for (const n of state.map.nodes) {
      kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
      if (typeof n.metrics?.depth === 'number') { depthSum += n.metrics.depth; depthCount++; }
    }
    const total = state.map.nodes.length || 1;
    const kindRows = Object.entries(kinds).map(([k, v]) => ({
      kind: k, count: v, pct: Math.round((v / total) * 100),
    }));
    const nodes = state.map.nodes;
    const topFanIn = [...nodes].sort((a, b) => b.metrics.fanIn - a.metrics.fanIn).slice(0, 5);
    const topFanOut = [...nodes].sort((a, b) => b.metrics.fanOut - a.metrics.fanOut).slice(0, 5);
    const islands = state.map.islands ?? [];
    const biggestIsland = islands.reduce((m, i) => Math.max(m, i.length), 0);
    const avgDepth = depthCount === 0 ? 0 : (depthSum / depthCount).toFixed(1);
    return {
      kindRows, topFanIn, topFanOut,
      edges: state.map.edges.length,
      islands: islands.length,
      biggestIsland,
      avgDepth,
    };
  }, [state.map]);

  return (
    <StatsBlock title="Service topology" hint="Call-graph aggregates">
      {state.status === 'loading' && <div className="stats-empty">loading…</div>}
      {state.status === 'error' && <div className="stats-empty stats-error">unavailable — {state.error}</div>}
      {state.status === 'empty' && <div className="stats-empty">service map disabled — enable call-graph in inspector options</div>}
      {state.status === 'ready' && summary && (
        <div className="topology-grid">
          <div className="topology-kind-strip">
            {summary.kindRows.map((k) => (
              <div key={k.kind} className="topology-kind-tile">
                <div className="topology-kind-label">{k.kind}</div>
                <div className="topology-kind-count">{k.count}</div>
                <MiniBar pct={k.pct} />
                <div className="topology-kind-pct">{k.pct}%</div>
              </div>
            ))}
          </div>
          <div className="topology-rank-grid">
            <div className="topology-rank-table">
              <div className="topology-rank-head">Top fan-in</div>
              {summary.topFanIn.length === 0 ? <div className="muted small">none</div> : summary.topFanIn.map((n) => (
                <div key={`fi-${n.id}`} className="topology-rank-row">
                  <span className="topology-rank-name" title={n.fullName ?? n.label}>{n.label}</span>
                  <span className="topology-rank-num">{n.metrics.fanIn}</span>
                </div>
              ))}
            </div>
            <div className="topology-rank-table">
              <div className="topology-rank-head">Top fan-out</div>
              {summary.topFanOut.length === 0 ? <div className="muted small">none</div> : summary.topFanOut.map((n) => (
                <div key={`fo-${n.id}`} className="topology-rank-row">
                  <span className="topology-rank-name" title={n.fullName ?? n.label}>{n.label}</span>
                  <span className="topology-rank-num">{n.metrics.fanOut}</span>
                </div>
              ))}
            </div>
            <div className="topology-summary-tile">
              <div><span className="muted">edges</span><b>{summary.edges}</b></div>
              <div><span className="muted">islands</span><b>{summary.islands}</b></div>
              <div><span className="muted">biggest island</span><b>{summary.biggestIsland}</b></div>
              <div><span className="muted">avg depth</span><b>{summary.avgDepth}</b></div>
            </div>
          </div>
        </div>
      )}
    </StatsBlock>
  );
}

function RecentCommits() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error' | 'empty'; commits: GitCommit[]; error?: string }>(
    { status: 'loading', commits: [] },
  );
  useEffect(() => {
    let abort = false;
    getGitLog(10).then((res) => {
      if (abort) return;
      if (!res.commits || res.commits.length === 0) { setState({ status: 'empty', commits: [] }); return; }
      setState({ status: 'ready', commits: res.commits });
    }).catch((e) => {
      if (abort) return;
      setState({ status: 'error', commits: [], error: String(e?.message ?? e) });
    });
    return () => { abort = true; };
  }, []);

  return (
    <StatsBlock title="Recent commits" hint="Last 10 from local git">
      {state.status === 'loading' && <div className="stats-empty">loading…</div>}
      {state.status === 'error' && <div className="stats-empty stats-error">unavailable — {state.error}</div>}
      {state.status === 'empty' && <div className="stats-empty">no commits available</div>}
      {state.status === 'ready' && (
        <ul className="commits-strip">
          {state.commits.map((c) => (
            <li key={c.sha} className="commits-row">
              <span className="commits-sha">{c.shortSha}</span>
              <span className="commits-subject" title={c.subject}>{c.subject}</span>
              <span className="commits-author">{c.author}</span>
              <span className="commits-time">{relativeTime(c.date)}</span>
              {c.traced && <span className="commits-traced" title="touched scenario files">●</span>}
            </li>
          ))}
        </ul>
      )}
    </StatsBlock>
  );
}

function SubTotalsFooter({ subTotals, scenarios, endpoints }: {
  subTotals: {
    samples: number; params: number; responses: number;
    mutations: number; breakpoints: number; caseVariants: number;
    groupsCount: number; edgesCount: number;
  };
  scenarios: number; endpoints: number;
}) {
  const tiles: { label: string; value: number }[] = [
    { label: 'endpoints', value: endpoints },
    { label: 'scenarios', value: scenarios },
    { label: 'samples', value: subTotals.samples },
    { label: 'parameters', value: subTotals.params },
    { label: 'response shapes', value: subTotals.responses },
    { label: 'edges', value: subTotals.edgesCount },
    { label: 'groups', value: subTotals.groupsCount },
    { label: 'mutations', value: subTotals.mutations },
    { label: 'breakpoints', value: subTotals.breakpoints },
    { label: 'case variants', value: subTotals.caseVariants },
  ];
  return (
    <StatsBlock title="Granular totals" hint="Every counted thing in the workspace">
      <div className="sub-totals-strip">
        {tiles.map((t) => (
          <div key={t.label} className="sub-total-tile">
            <div className="sub-total-value">{t.value}</div>
            <div className="sub-total-label">{t.label}</div>
          </div>
        ))}
      </div>
    </StatsBlock>
  );
}

function MiniBar({ pct, variant }: { pct: number; variant?: string }) {
  return (
    <div className={`mini-bar ${variant ? `mini-bar-${variant}` : ''}`}>
      <div className="mini-bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function DotStrip({ statuses }: { statuses: RunStatus[] }) {
  if (statuses.length === 0) {
    return <span className="dot-strip empty">no recent runs</span>;
  }
  return (
    <span className="dot-strip" aria-label={`last ${statuses.length} run statuses`}>
      {statuses.map((s, i) => (
        <span key={i} className={`dot-strip-circle dot-${dotTone(s)}`} title={s} />
      ))}
    </span>
  );
}

function dotTone(s: RunStatus): 'ok' | 'bad' | 'warn' | 'muted' {
  if (s === 'succeeded') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'running' || s === 'paused') return 'warn';
  return 'muted';
}

function StatusPill({ status }: { status: RunStatus }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function ScenariosSection({ onBack, scenarios, runs }: {
  onBack: () => void; scenarios: Scenario[]; runs: Run[];
}) {
  const runsByScenario = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs) {
      if (!m.has(r.scenarioId)) m.set(r.scenarioId, []);
      m.get(r.scenarioId)!.push(r);
    }
    return m;
  }, [runs]);

  return (
    <>
      <SectionHead title="Scenarios Details" onBack={onBack} />
      {scenarios.length === 0 && (
        <div className="empty-state" role="status">
          <div className="empty-state-icon" aria-hidden="true"><BeakerSvg /></div>
          <div className="empty-state-title">No scenarios yet</div>
          <div className="empty-state-body">
            Use the “new flow” control in the sidebar to compose your first business flow.
          </div>
        </div>
      )}
      <div className="scn-list">
        {scenarios.map((s) => {
          const rs = runsByScenario.get(s.id) ?? [];
          const ok = rs.filter((r) => r.status === 'succeeded').length;
          const bad = rs.filter((r) => r.status === 'failed').length;
          return (
            <div key={s.id} className="scn-row">
              <div className="scn-name">{s.name}</div>
              <div className="scn-meta">
                <span>{s.nodes.length} nodes</span>
                <span>{(s.edges?.length ?? 0)} edges</span>
                <span>{(s.groups?.length ?? 0)} groups</span>
                <span>{rs.length} runs</span>
                {ok > 0 && <span className="ok">✓ {ok}</span>}
                {bad > 0 && <span className="bad">✗ {bad}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function SectionHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="section-head">
      <button className="back-arrow" onClick={onBack} title="Back">←</button>
      <h2>{title}</h2>
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`kpi tone-${tone ?? 'default'}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

function BeakerSvg() {
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6" />
      <path d="M10 3v6L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3" />
      <path d="M7 14h10" />
    </svg>
  );
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

type SettingsTab = 'auth' | 'agent' | 'settings';

interface Warning {
  id: string;
  title: string;
  message: string;
  /** When set, the popover renders an action button that calls back into the parent. */
  actionLabel?: string;
  /** Which settings tab to land on when the action fires. */
  actionTab?: SettingsTab;
}

interface WorkspaceWarningsProps {
  warnings: Warning[];
  onAction: (tab?: SettingsTab) => void;
}

/**
 * Hover-trigger warning bell — sits next to the search hint and pops over a
 * stacked list of setup-gap reminders. Closes on outside click and on Escape.
 */
function WorkspaceWarnings({ warnings, onAction }: WorkspaceWarningsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="workspace-warn" ref={ref}>
      <button
        type="button"
        className="workspace-warn-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${warnings.length} workspace warning${warnings.length === 1 ? '' : 's'}`}
        title="Workspace warnings"
      >
        <span className="workspace-warn-count">{warnings.length}</span>
        <span className="workspace-warn-icon" aria-hidden="true">⚠</span>
      </button>
      {open && (
        <div className="workspace-warn-popup" role="dialog" aria-label="workspace warnings">
          <header className="workspace-warn-popup-head">
            <span className="workspace-warn-popup-title">workspace warnings</span>
            <span className="workspace-warn-popup-count">{warnings.length}</span>
          </header>
          <ul className="workspace-warn-popup-list" role="list">
            {warnings.map((w) => (
              <li key={w.id} className="workspace-warn-item">
                <div className="workspace-warn-item-head">
                  <span className="workspace-warn-item-icon" aria-hidden="true">⚠</span>
                  <span className="workspace-warn-item-title">{w.title}</span>
                </div>
                <p className="workspace-warn-item-msg">{w.message}</p>
                {w.actionLabel && (
                  <button
                    type="button"
                    className="workspace-warn-item-action"
                    onClick={() => { setOpen(false); onAction(w.actionTab); }}
                  >
                    {w.actionLabel} →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
