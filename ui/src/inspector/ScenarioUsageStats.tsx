interface Props {
  /** Scenarios that include this endpoint (METHOD path). */
  scenariosUsing: { id: string; name: string; passed: number; failed: number }[];
  /** Total pass/fail across all runs of this endpoint, summed across scenarios. */
  totals: { passed: number; failed: number };
}

export function ScenarioUsageStats({ scenariosUsing, totals }: Props) {
  const used = scenariosUsing.length;
  const sum = totals.passed + totals.failed;
  const passPct = sum === 0 ? 0 : (totals.passed / sum) * 100;
  const failPct = sum === 0 ? 0 : (totals.failed / sum) * 100;

  if (used === 0) {
    return <div className="muted small">{`> not yet used in any scenario.`}</div>;
  }

  return (
    <div className="usage-stats">
      <div className="usage-stat-line">
        <span className="usage-numeral">{used}</span>
        <span className="usage-numeral-label">scenario{used === 1 ? '' : 's'} use this endpoint</span>
      </div>
      <pre className="usage-list">
        {scenariosUsing.map((s) => {
          const ok = s.passed;
          const bad = s.failed;
          const total = ok + bad;
          const dotted = '.'.repeat(Math.max(2, 28 - s.name.length));
          const stat = total === 0 ? 'untested' : `${ok}/${total} pass`;
          return (
            <span key={s.id} className="usage-row">
              <span className="usage-name">{s.name}</span>
              {' '}
              <span className="schema-dim">{dotted}</span>
              {' '}
              <span className={`usage-stat ${total === 0 ? 'pending' : ok === total ? 'ok' : bad > 0 && ok === 0 ? 'fail' : 'mixed'}`}>
                [{stat}]
              </span>
              {'\n'}
            </span>
          );
        })}
      </pre>
      {sum > 0 && (
        <div className="coverage-bars">
          <div className="coverage-row">
            <span className="coverage-label">pass</span>
            <div className="coverage-track">
              <div className="coverage-fill coverage-fill-pass" style={{ width: `${passPct}%` }} />
            </div>
            <span className="coverage-count">{totals.passed}</span>
          </div>
          <div className="coverage-row">
            <span className="coverage-label">fail</span>
            <div className="coverage-track">
              <div className="coverage-fill coverage-fill-fail" style={{ width: `${failPct}%` }} />
            </div>
            <span className="coverage-count">{totals.failed}</span>
          </div>
        </div>
      )}
    </div>
  );
}
