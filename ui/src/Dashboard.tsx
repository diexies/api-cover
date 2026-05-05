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
  return (
    <>
      <h1 className="dash2-title">APICover</h1>
      <p className="dash2-sub">choose where to start</p>

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
      {scenarios.length === 0 && <div className="muted">no scenarios yet</div>}
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
