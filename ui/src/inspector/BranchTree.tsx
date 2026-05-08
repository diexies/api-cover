import { useMemo } from 'react';
import type { CaseSet, NodeResult, Run } from '../api';
import { branchKey } from '../api';

interface Props {
  run: Run | null | undefined;
  caseSets?: CaseSet[];
}

/**
 * Tree view of a branched run. Groups <see cref="NodeResult"/> entries by branch path so
 * users can see which combinations of variant choices passed or failed in a single glance.
 * Renders nothing when no branched results exist (single-path runs keep the legacy view).
 */
export function BranchTree({ run, caseSets }: Props) {
  const branches = useMemo(() => groupBranches(run, caseSets ?? []), [run, caseSets]);
  if (!run || branches.length === 0) return null;

  // Worst-wins rollup across all branches: any failure dominates, then running, then
  // pending; succeeded only when every leaf succeeded. Mirrors Vitest/Playwright semantics.
  const rollup = rollupAggregate(branches);
  const totals = branches.reduce(
    (acc, b) => {
      acc.passed += b.aggregate === 'succeeded' ? 1 : 0;
      acc.failed += b.aggregate === 'failed' ? 1 : 0;
      acc.running += b.aggregate === 'running' ? 1 : 0;
      acc.skipped += b.aggregate === 'skipped' ? 1 : 0;
      return acc;
    },
    { passed: 0, failed: 0, running: 0, skipped: 0 },
  );

  return (
    <div className="branch-tree">
      <div className="branch-tree-head">
        <span className="term-heading term-heading-comment">{`# branch tree (${branches.length} leaf${branches.length === 1 ? '' : 'es'})`}</span>
        <BranchStatusPill aggregate={rollup} />
        <span className="branch-tree-totals" aria-label="branch totals">
          <span className="branch-tree-total ok" title="passed">{totals.passed}/{branches.length}</span>
          {totals.failed > 0 && <span className="branch-tree-total fail" title="failed">✗ {totals.failed}</span>}
          {totals.running > 0 && <span className="branch-tree-total run" title="running">⏵ {totals.running}</span>}
          {totals.skipped > 0 && <span className="branch-tree-total skip" title="skipped">⊘ {totals.skipped}</span>}
        </span>
      </div>
      <ul className="branch-tree-list">
        {branches.map((b) => (
          <li key={b.key}>
            <BranchStatusPill aggregate={b.aggregate} />
            <code className="branch-path-key">{b.key || 'root'}</code>
            <span className="muted small">
              {`${b.results.length} node${b.results.length === 1 ? '' : 's'}`}
              {' · '}
              {b.passed} ok{b.failed > 0 ? ` · ${b.failed} fail` : ''}
            </span>
            {b.labelChain.length > 0 && (
              <span className="branch-label-chain">{b.labelChain.join(' › ')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_ICON: Record<BranchSummary['aggregate'], string> = {
  succeeded: '✓',
  failed: '✗',
  running: '⏵',
  pending: '·',
  skipped: '⊘',
};

function BranchStatusPill({ aggregate }: { aggregate: BranchSummary['aggregate'] }) {
  return (
    <span
      className={`branch-status branch-status-${aggregate}`}
      role="status"
      aria-label={aggregate}
    >
      <span aria-hidden="true">{STATUS_ICON[aggregate]}</span>
      <span>{aggregate}</span>
    </span>
  );
}

function rollupAggregate(branches: BranchSummary[]): BranchSummary['aggregate'] {
  if (branches.some((b) => b.aggregate === 'failed')) return 'failed';
  if (branches.some((b) => b.aggregate === 'running')) return 'running';
  if (branches.every((b) => b.aggregate === 'succeeded')) return 'succeeded';
  if (branches.every((b) => b.aggregate === 'skipped')) return 'skipped';
  return 'pending';
}

interface BranchSummary {
  key: string;
  segments: string[];
  labelChain: string[];
  results: NodeResult[];
  passed: number;
  failed: number;
  aggregate: 'succeeded' | 'failed' | 'running' | 'pending' | 'skipped';
}

function groupBranches(run: Run | null | undefined, caseSets: CaseSet[]): BranchSummary[] {
  if (!run) return [];
  const buckets = new Map<string, NodeResult[]>();
  for (const r of run.nodeResults) {
    const key = branchKey(r);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  // Skip the root bucket if any branched buckets exist — root only carries dispatch placeholders.
  const branched = [...buckets.entries()].filter(([k]) => k.length > 0);
  if (branched.length === 0) return [];

  const out: BranchSummary[] = branched.map(([key, results]) => {
    const passed = results.filter((r) => r.status === 'succeeded').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    let aggregate: BranchSummary['aggregate'] = 'pending';
    if (results.some((r) => r.status === 'running')) aggregate = 'running';
    else if (failed > 0) aggregate = 'failed';
    else if (results.every((r) => r.status === 'succeeded')) aggregate = 'succeeded';
    else if (results.every((r) => r.status === 'skipped' || r.status === 'cancelled')) aggregate = 'skipped';
    const segments = key.split('/');
    const labelChain = labelChainFor(segments, caseSets);
    return { key, segments, labelChain, results, passed, failed, aggregate };
  });
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

function labelChainFor(segments: string[], caseSets: CaseSet[]): string[] {
  const labels: string[] = [];
  for (const seg of segments) {
    const variant = caseSets
      .flatMap((c) => c.variants.map((v) => ({ cs: c, v })))
      .find(({ v }) => v.id === seg);
    labels.push(variant ? `${variant.cs.label ?? variant.cs.id}: ${variant.v.label}` : seg);
  }
  return labels;
}
