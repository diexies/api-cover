import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentStatus, EndpointDescriptor, Run, Scenario } from './api';
import type { AuthConfig } from './auth';
import { ChatComposer } from './home/ChatComposer';
import { CapabilityChips } from './home/CapabilityChips';
import { GitTimeline } from './home/GitTimeline';
import { coverage } from './home/utils';

const CHAT_DRAFT_KEY = 'apicover.chatDraft';

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

const KNOWN_MODES = new Set(['scenario', 'scan', 'explain', 'map']);

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
  // Wrap in try/catch because Safari Private Mode + some embedded contexts
  // throw on localStorage writes once they hit quota.
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
          try { localStorage.setItem(CHAT_DRAFT_KEY, rest); } catch { /* quota */ }
          return;
        }
      }
    }
    setDraft(v);
    try { localStorage.setItem(CHAT_DRAFT_KEY, v); } catch { /* quota / disabled */ }
  }
  function handleSubmit(text: string) {
    const t = text.trim();
    if (!t) return;
    try { localStorage.removeItem(CHAT_DRAFT_KEY); } catch { /* same as above */ }
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
      title: 'AI mode disabled',
      message: 'Pick API key or Max in agent settings — the chat composer and scan need credentials before they can run.',
      actionLabel: 'open settings',
      actionTab: 'agent',
    });
  } else if (agentStatus.mode === 'ApiKey' && !agentStatus.hasApiKey) {
    warnings.push({
      id: 'agent-key-missing',
      title: 'Anthropic API key missing',
      message: 'Agent is set to API key mode but no key is saved yet. Paste a key into Agent settings to enable runs.',
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
  try { return localStorage.getItem(CHAT_DRAFT_KEY) ?? ''; } catch { return ''; }
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

function StatsSection({ onBack, endpoints, scenarios, runs }: {
  onBack: () => void;
  endpoints: EndpointDescriptor[]; scenarios: Scenario[]; runs: Run[];
}) {
  const { covered, uncovered, pct } = useMemo(() => coverage(endpoints, scenarios), [endpoints, scenarios]);
  const now = Date.now();
  const dayMs = 86_400_000;
  const today = runs.filter((r) => r.startedAt && now - new Date(r.startedAt).getTime() < dayMs).length;
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const failed = runs.filter((r) => r.status === 'failed').length;

  return (
    <>
      <SectionHead title="Statistics" onBack={onBack} />
      <div className="kpi-row">
        <Kpi label="APIs" value={endpoints.length} />
        <Kpi label="Scenarios" value={scenarios.length} />
        <Kpi label="Runs total" value={runs.length} hint={`${today} today`} />
        <Kpi label="Coverage" value={`${pct}%`} hint={`${covered} / ${endpoints.length}`} tone={pct >= 70 ? 'good' : pct >= 30 ? 'warn' : 'bad'} />
        <Kpi label="Untested" value={uncovered} tone={uncovered === 0 ? 'good' : 'warn'} />
        <Kpi label="Succeeded" value={succeeded} tone="good" />
        <Kpi label="Failed" value={failed} tone={failed === 0 ? 'default' : 'bad'} />
      </div>
    </>
  );
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
