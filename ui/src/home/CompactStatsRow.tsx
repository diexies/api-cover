import { useMemo } from 'react';
import type { EndpointDescriptor, Run, Scenario } from '../api';
import { coverage } from './utils';

interface Props {
  endpoints: EndpointDescriptor[];
  scenarios: Scenario[];
  runs: Run[];
  onOpenStats: () => void;
  onOpenScenarios: () => void;
  onOpenSettings: () => void;
}

/**
 * One-line summary of the workspace + three text-button affordances. Numbers
 * mirror StatsSection's KPIs to the percent (both pull from {@link coverage}).
 */
export function CompactStatsRow({
  endpoints, scenarios, runs,
  onOpenStats, onOpenScenarios, onOpenSettings,
}: Props) {
  const cov = useMemo(() => coverage(endpoints, scenarios), [endpoints, scenarios]);

  return (
    <div className="compact-stats">
      <div className="compact-stats-text">
        <Stat label="apis" value={endpoints.length} />
        <Sep />
        <Stat label="scenarios" value={scenarios.length} />
        <Sep />
        <Stat label="coverage" value={`${cov.pct}%`} />
        <Sep />
        <Stat label="runs" value={runs.length} />
      </div>
      <div className="compact-stats-tiles">
        <button type="button" className="compact-stats-tile" onClick={onOpenStats}>
          stats →
        </button>
        <button type="button" className="compact-stats-tile" onClick={onOpenScenarios}>
          scenarios →
        </button>
        <button type="button" className="compact-stats-tile" onClick={onOpenSettings}>
          settings →
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="compact-stats-pair">
      <span className="compact-stats-label">{label}</span>
      <span className="compact-stats-value">{value}</span>
    </span>
  );
}

function Sep() {
  return <span className="compact-stats-sep" aria-hidden="true">·</span>;
}
