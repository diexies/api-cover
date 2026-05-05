import { useMemo, useState } from 'react';
import type { ExecutionGroup, NodeMutation } from '../api';
import { evaluateRule, UnsupportedOpError } from './jsonlogic-eval';

interface Props {
  groups: ExecutionGroup[];
  nodeId: string;
}

interface Branch {
  iteration: number;
  total: number;
  cells: { field: string; value: unknown; error?: string }[];
}

const DEFAULT_VISIBLE = 24;

export function BranchSimulator({ groups, nodeId }: Props) {
  const [seed, setSeed] = useState(0);
  const [showAll, setShowAll] = useState(false);

  if (groups.length === 0) {
    return (
      <div className="muted small">
        {`> this api is not in a repeated group. drop it inside an area on the canvas to see branching.`}
      </div>
    );
  }

  // Multi-group → cartesian preview using the first group's iterations as outer loop and
  // joining each inner group's mutated cells into a single row per (outerIter, innerIter…).
  // For now: render each group independently when multiple, with a banner; users can edit
  // mutations per group.
  return (
    <div className="branch-sim">
      {groups.length > 1 && (
        <div className="warn-card">
          <strong>{`[!] cartesian product`}</strong>
          <div className="muted small">
            {`> this node sits in ${groups.length} groups; engine runs `}
            <code>
              {groups.map((g) => g.repeat?.count ?? 1).join(' × ')}
              {' = '}
              {groups.reduce((a, g) => a * Math.max(1, g.repeat?.count ?? 1), 1)}
            </code>
            {` iterations per scenario run. each group is shown below.`}
          </div>
        </div>
      )}
      {groups.map((g) => (
        <GroupBranchView
          key={g.id}
          group={g}
          nodeId={nodeId}
          seed={seed}
          showAll={showAll}
          onSetShowAll={() => setShowAll(true)}
        />
      ))}
      <div className="branch-actions">
        <button className="chip" onClick={() => setSeed(Math.random())} title="re-seed random">
          ↻ reroll random
        </button>
      </div>
    </div>
  );
}

function GroupBranchView({
  group, nodeId, seed, showAll, onSetShowAll,
}: { group: ExecutionGroup; nodeId: string; seed: number; showAll: boolean; onSetShowAll: () => void }) {
  const mutations = (group.mutations ?? []).filter((m) => m.nodeId === nodeId);
  const count = Math.max(1, group.repeat?.count ?? 1);

  const branches = useMemo(() => simulate(count, mutations, seed), [count, mutations, seed]);

  const visible = showAll ? branches : branches.slice(0, DEFAULT_VISIBLE);
  const overflow = !showAll && branches.length > DEFAULT_VISIBLE;

  const labelLine = `# group "${group.label ?? group.id}" × ${count}    mutations: ${mutations.length}`;

  return (
    <div className="branch-group">
      <div className="branch-group-head">{labelLine}</div>
      {mutations.length === 0 && (
        <div className="muted small">
          {`> no mutations declared on this node. add some in [edit mutations] to see per-iteration changes.`}
        </div>
      )}
      <pre className="branch-rows">
        {visible.map((b) => (
          <span key={b.iteration} className="branch-row">
            <span className="branch-iter">{`iter ${pad(b.iteration, count)}`}</span>
            {b.cells.length === 0 ? (
              <span className="branch-cell muted">  (no field changes)</span>
            ) : (
              b.cells.map((c, i) => (
                <span key={i} className="branch-cell">
                  {'  '}
                  <span className="branch-field">{c.field}</span>
                  {' = '}
                  {c.error ? (
                    <span className="branch-err">[!] {c.error}</span>
                  ) : (
                    <span className="branch-val">{formatValue(c.value)}</span>
                  )}
                </span>
              ))
            )}
            {'\n'}
          </span>
        ))}
        {overflow && (
          <span className="branch-row branch-overflow" onClick={onSetShowAll}>
            {`> show all ${branches.length} iterations`}{'\n'}
          </span>
        )}
      </pre>
    </div>
  );
}

function simulate(count: number, mutations: NodeMutation[], seed: number): Branch[] {
  const rng = mulberry32(Math.floor(seed * 1e9) || 1);
  const out: Branch[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = {
      iteration: i,
      total: count,
      random: rng(),
      previous: null,
      groups: {},
    };
    const cells = mutations.map((m) => {
      try {
        return { field: m.field, value: evaluateRule(m.rule, ctx) };
      } catch (e) {
        const msg = e instanceof UnsupportedOpError ? e.message : (e as Error).message;
        return { field: m.field, value: undefined, error: msg };
      }
    });
    out.push({ iteration: i, total: count, cells });
  }
  return out;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(i: number, total: number): string {
  const w = String(total - 1).length;
  return String(i).padStart(w, '0');
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  try { return JSON.stringify(v); } catch { return String(v); }
}
