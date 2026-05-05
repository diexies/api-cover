import type { NodeIteration } from '../api';
import { ScenarioUsageStats } from './ScenarioUsageStats';
import { IterationList } from './IterationList';

interface Props {
  scenariosUsing: { id: string; name: string; passed: number; failed: number }[];
  endpointTotals: { passed: number; failed: number };
  iterations?: NodeIteration[];
  scenarioName: string;
}

export function HistoryTab({ scenariosUsing, endpointTotals, iterations, scenarioName }: Props) {
  return (
    <div className="tab-pane-content">
      <div className="history-section">
        <div className="term-heading term-heading-comment">{`# usage (across scenarios)`}</div>
        <ScenarioUsageStats scenariosUsing={scenariosUsing} totals={endpointTotals} />
      </div>

      <div className="history-section">
        <div className="term-heading term-heading-action">{`$ runs (this scenario: ${scenarioName})`}</div>
        {iterations && iterations.length > 0 ? (
          <IterationList iterations={iterations} />
        ) : (
          <div className="muted small">{`> not yet run in this scenario.`}</div>
        )}
      </div>
    </div>
  );
}
