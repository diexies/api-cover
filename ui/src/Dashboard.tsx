import { useMemo, useState } from 'react';
import type { EndpointDescriptor, Run, Scenario } from './api';

interface Props {
  scenarios: Scenario[];
  endpoints: EndpointDescriptor[];
  runs: Run[];
  onOpenGlobalSettings: () => void;
}

type Section = 'home' | 'stats' | 'scenarios';

/**
 * Workspace landing. Three hero cards (Statistics / Scenarios Details / Global Settings)
 * acting as primary navigation, plus a slim Import / Export row underneath. Clicking a card
 * swaps the body in-place; Global Settings hands off to the existing modal.
 */
export function Dashboard({ scenarios, endpoints, runs, onOpenGlobalSettings }: Props) {
  const [section, setSection] = useState<Section>('home');

  return (
    <div className="dash2">
      {section === 'home' && (
        <HomeSection
          endpoints={endpoints}
          scenarios={scenarios}
          runs={runs}
          onOpenStats={() => setSection('stats')}
          onOpenScenarios={() => setSection('scenarios')}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      )}
      {section === 'stats' && (
        <StatsSection
          onBack={() => setSection('home')}
          endpoints={endpoints}
          scenarios={scenarios}
          runs={runs}
        />
      )}
      {section === 'scenarios' && (
        <ScenariosSection
          onBack={() => setSection('home')}
          scenarios={scenarios}
          runs={runs}
        />
      )}
    </div>
  );
}

function HomeSection({
  endpoints, scenarios, runs,
  onOpenStats, onOpenScenarios, onOpenGlobalSettings,
}: {
  endpoints: EndpointDescriptor[]; scenarios: Scenario[]; runs: Run[];
  onOpenStats: () => void; onOpenScenarios: () => void; onOpenGlobalSettings: () => void;
}) {
  // First-run state: no scenarios saved. Surface a 3-step checklist as the primary
  // CTA cluster instead of dropping the user into an inert hero strip with zero counts.
  const isFirstRun = scenarios.length === 0;

  return (
    <>
      <h1 className="dash2-title">APICover</h1>
      <p className="dash2-sub">
        {isFirstRun ? 'set up your first business flow' : 'choose where to start'}
      </p>
      <div className="dash2-hint" aria-hidden="true">
        Press <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>+<kbd>K</kbd> to search anywhere
      </div>

      {isFirstRun && (
        <FirstRunChecklist
          endpoints={endpoints}
          onOpenGlobalSettings={onOpenGlobalSettings}
        />
      )}

      <div className="hero-cards">
        <HeroCard
          tone="sky"
          icon={<IconStats />}
          title="Statistics"
          description={`${runs.length} runs · ${endpoints.length} APIs · live coverage`}
          onClick={onOpenStats}
        />
        <HeroCard
          tone="cream"
          icon={<IconBeaker />}
          title="Scenarios Details"
          description={`${scenarios.length} scenarios on file · drill into nodes & history`}
          onClick={onOpenScenarios}
        />
        <HeroCard
          tone="rose"
          icon={<IconGear />}
          title="Global Settings"
          description="auth credentials · workspace defaults"
          onClick={onOpenGlobalSettings}
        />
      </div>

      <button className="ie-bar">
        <span className="ie-bar-half ie-import">⤓ Import</span>
        <span className="ie-bar-divider" />
        <span className="ie-bar-half ie-export">⤒ Export</span>
      </button>
    </>
  );
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
  onOpenGlobalSettings: () => void;
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

function HeroCard({ tone, icon, title, description, onClick }: {
  tone: 'sky' | 'cream' | 'rose';
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button className={`hero-card hero-${tone}`} onClick={onClick}>
      <div className="hero-emoji-wrap">{icon}</div>
      <div className="hero-title">{title}</div>
      <div className="hero-desc">{description}</div>
    </button>
  );
}

function IconStats() {
  return (
    <svg width={42} height={42} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-7" />
    </svg>
  );
}

function IconBeaker() {
  return (
    <svg width={42} height={42} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6" />
      <path d="M10 3v6L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3" />
      <path d="M7 14h10" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width={42} height={42} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
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
          <div className="empty-state-icon" aria-hidden="true"><IconBeaker /></div>
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

function coverage(endpoints: EndpointDescriptor[], scenarios: Scenario[]) {
  const used = new Set<string>();
  for (const s of scenarios) {
    for (const n of s.nodes) used.add(`${n.method.toUpperCase()} ${normalisePath(n.path)}`);
  }
  let c = 0;
  for (const ep of endpoints) {
    if (used.has(`${ep.method.toUpperCase()} ${normalisePath(ep.path)}`)) c++;
  }
  return { covered: c, uncovered: endpoints.length - c, pct: endpoints.length === 0 ? 0 : Math.round((c / endpoints.length) * 100) };
}

function normalisePath(p: string): string { return p.replace(/\{([^:}]+):[^}]+\}/g, '{$1}'); }

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}
