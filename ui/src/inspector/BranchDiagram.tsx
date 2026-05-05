import { useMemo } from 'react';
import type { ApiNode, CaseSet, ExecutionGroup, Edge, NodeResult, Run } from '../api';
import { branchKey } from '../api';

interface Props {
  run: Run | null | undefined;
  nodes: ApiNode[];
  edges: Edge[];
  caseSets?: CaseSet[];
  groups?: ExecutionGroup[];
  selectedBranchKey: string | null;
  onSelectBranch: (key: string | null) => void;
  onFocusNode: (id: string, branchKey: string) => void;
}

/**
 * Visual swimlane diagram of a forked run. One horizontal lane per branch (case-set variant
 * combination, group repeat iteration, or both). Each lane renders the node results that
 * actually executed on that branch as a left-to-right chain of mini api-node cells with arrow
 * connectors. Replaces the older flat-list BranchTree so the user sees the fork structure
 * spatially instead of as a bullet list.
 *
 * Click a lane → select that branch (drives the per-branch canvas filter).
 * Click a cell → focus that node on the canvas while pinning the branch view.
 */
export function BranchDiagram({
  run,
  nodes,
  edges,
  caseSets,
  groups,
  selectedBranchKey,
  onSelectBranch,
  onFocusNode,
}: Props) {
  const order = useMemo(() => topologicalOrder(nodes, edges), [nodes, edges]);
  const lanes = useMemo(
    () => buildLanes(run, order, caseSets ?? [], groups ?? []),
    [run, order, caseSets, groups]
  );

  if (!run || lanes.length === 0) return null;

  return (
    <div className="branch-diagram">
      <div className="branch-diagram-head">
        <span className="branch-diagram-title">
          branches <span className="branch-diagram-count">{lanes.length}</span>
        </span>
        {selectedBranchKey != null && (
          <button
            type="button"
            className="branch-diagram-clear"
            onClick={() => onSelectBranch(null)}
          >
            show all
          </button>
        )}
      </div>
      <div className="branch-diagram-lanes">
        {lanes.map((lane) => {
          const isActive = selectedBranchKey === lane.key;
          return (
            <div
              key={lane.key}
              className={`branch-lane status-${lane.aggregate} ${isActive ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectBranch(isActive ? null : lane.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectBranch(isActive ? null : lane.key);
                }
              }}
              title={lane.key}
            >
              <div className="branch-lane-header">
                <span className={`branch-lane-status status-${lane.aggregate}`}>
                  {lane.aggregate}
                </span>
                <span className="branch-lane-label">{lane.label}</span>
                <span className="branch-lane-stats">
                  {lane.passed} ok{lane.failed > 0 ? ` · ${lane.failed} fail` : ''}
                </span>
              </div>
              <div className="branch-lane-flow">
                {lane.cells.map((cell, i) => (
                  <span key={cell.nodeId} className="branch-lane-cell-wrap">
                    {i > 0 && <span className="branch-lane-arrow" aria-hidden>→</span>}
                    <button
                      type="button"
                      className={`branch-lane-cell status-${cell.status} method-${cell.method.toLowerCase()}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onSelectBranch(lane.key);
                        onFocusNode(cell.nodeId, lane.key);
                      }}
                      title={`${cell.method} ${cell.path}\n${cell.status}${cell.httpStatus ? ` · HTTP ${cell.httpStatus}` : ''}`}
                    >
                      <span className="branch-lane-cell-method">{cell.method}</span>
                      <span className="branch-lane-cell-id">{cell.label}</span>
                      {cell.httpStatus && (
                        <span className="branch-lane-cell-http">{cell.httpStatus}</span>
                      )}
                    </button>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Cell {
  nodeId: string;
  label: string;
  method: string;
  path: string;
  status: 'succeeded' | 'failed' | 'running' | 'paused' | 'pending' | 'skipped' | 'cancelled';
  httpStatus?: number;
}

interface Lane {
  key: string;
  label: string;
  cells: Cell[];
  aggregate: 'succeeded' | 'failed' | 'running' | 'pending' | 'skipped';
  passed: number;
  failed: number;
}

function buildLanes(
  run: Run | null | undefined,
  topoOrder: string[],
  caseSets: CaseSet[],
  groups: ExecutionGroup[]
): Lane[] {
  if (!run) return [];
  const nodeById = new Map<string, { method: string; path: string; label: string }>();
  // We rebuild the lookup from topo order indirectly — we know nodes by their results.

  const buckets = new Map<string, NodeResult[]>();
  for (const r of run.nodeResults) {
    const k = branchKey(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }
  const branched = [...buckets.entries()].filter(([k]) => k.length > 0);
  if (branched.length === 0) return [];

  // Collect node descriptors from any result that has request/response (request carries method+path).
  for (const r of run.nodeResults) {
    if (nodeById.has(r.nodeId)) continue;
    if (r.request) {
      nodeById.set(r.nodeId, {
        method: r.request.method,
        path: r.request.path,
        label: r.nodeId,
      });
    }
  }

  const orderIndex = new Map<string, number>(topoOrder.map((id, i) => [id, i]));

  const lanes: Lane[] = branched.map(([key, results]) => {
    // Sort cells by topo order. Fall back to result append order for unknown nodes.
    const sorted = [...results].sort((a, b) => {
      const ai = orderIndex.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
    const cells: Cell[] = sorted.map((r) => {
      const meta = nodeById.get(r.nodeId);
      return {
        nodeId: r.nodeId,
        label: r.nodeId,
        method: meta?.method ?? r.request?.method ?? '?',
        path: meta?.path ?? r.request?.path ?? '',
        status: r.status,
        httpStatus: r.response?.status,
      };
    });
    const passed = results.filter((r) => r.status === 'succeeded').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    let aggregate: Lane['aggregate'] = 'pending';
    if (results.some((r) => r.status === 'running' || r.status === 'paused')) aggregate = 'running';
    else if (failed > 0) aggregate = 'failed';
    else if (results.every((r) => r.status === 'succeeded')) aggregate = 'succeeded';
    else if (results.every((r) => r.status === 'skipped' || r.status === 'cancelled')) aggregate = 'skipped';
    return {
      key,
      label: prettyBranchLabel(key, caseSets, groups),
      cells,
      aggregate,
      passed,
      failed,
    };
  });
  lanes.sort((a, b) => a.key.localeCompare(b.key));
  return lanes;
}

function prettyBranchLabel(key: string, caseSets: CaseSet[], groups: ExecutionGroup[]): string {
  const segs = key.split('/');
  const labels: string[] = [];
  for (const seg of segs) {
    const repeatMatch = /^(.+)#(\d+)$/.exec(seg);
    if (repeatMatch) {
      const grp = groups.find((g) => g.id === repeatMatch[1]);
      labels.push(`${grp?.label ?? repeatMatch[1]} ×${repeatMatch[2]}`);
      continue;
    }
    const variant = caseSets
      .flatMap((c) => c.variants.map((v) => ({ cs: c, v })))
      .find(({ v }) => v.id === seg);
    labels.push(variant ? `${variant.cs.label ?? variant.cs.id}: ${variant.v.label}` : seg);
  }
  return labels.join(' › ');
}

/** BFS topological order of node ids (for left-to-right cell layout in the lane). */
function topologicalOrder(nodes: ApiNode[], edges: Edge[]): string[] {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const n of nodes) outgoing.set(n.id, []);
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    outgoing.get(e.from)?.push(e.to);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nx of outgoing.get(cur) ?? []) {
      const d = (inDegree.get(nx) ?? 0) - 1;
      inDegree.set(nx, d);
      if (d === 0) queue.push(nx);
    }
  }
  // Append any nodes left behind (cycles shouldn't exist, but be safe).
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  return order;
}
