import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import { branchKey, type ExecutionGroup, type Run } from '../api';
import {
  BRANCH_LANE_SPREAD,
  branchCloneEdgeId,
  branchCloneRfId,
  isApiRf,
  isBranchCloneEdge,
  isBranchCloneRf,
} from './scenarioCanvasUtils';

/** Per-group branch fan-out plan derived from the run. */
export interface BranchPlan {
  /** groupId → ordered branchKeys observed in run.nodeResults. */
  branchesByGroup: Map<string, string[]>;
  /** Node ids whose original RF node should be hidden because clones exist. */
  inBranchOriginals: Set<string>;
  /** Node id → first group it belongs to. */
  inGroupOf: Map<string, ExecutionGroup>;
}

/**
 * Walk the current run + scenario groups to figure out which branches each group has and
 * which originals should be hidden behind clones. Pure — no React state.
 */
export function planBranchFanOut(run: Run | null, groups: ExecutionGroup[]): BranchPlan {
  const inGroupOf = new Map<string, ExecutionGroup>();
  for (const g of groups) {
    for (const nid of g.nodeIds) {
      if (!inGroupOf.has(nid)) inGroupOf.set(nid, g);
    }
  }
  const branchesByGroup = new Map<string, string[]>();
  if (run) {
    for (const r of run.nodeResults) {
      const fullKey = branchKey(r);
      if (fullKey === '') continue;
      for (const seg of r.branchPath ?? []) {
        const m = /^(.+)#(\d+)$/.exec(seg);
        if (!m) continue;
        const arr = branchesByGroup.get(m[1]) ?? [];
        if (!arr.includes(fullKey)) arr.push(fullKey);
        branchesByGroup.set(m[1], arr);
      }
    }
    for (const [, arr] of branchesByGroup) arr.sort();
  }
  const inBranchOriginals = new Set<string>();
  for (const [gid] of branchesByGroup) {
    const grp = groups.find((g) => g.id === gid);
    if (grp) for (const nid of grp.nodeIds) inBranchOriginals.add(nid);
  }
  return { branchesByGroup, inBranchOriginals, inGroupOf };
}

/** Pretty-print one branchKey segment (e.g. `g_alpha#2` → `g_alpha ×2`). */
function prettifySeg(seg: string, groups: ExecutionGroup[]): string {
  const rm = /^(.+)#(\d+)$/.exec(seg);
  if (!rm) return seg;
  const grpForSeg = groups.find((g) => g.id === rm[1]);
  return `${grpForSeg?.label ?? rm[1]} ×${rm[2]}`;
}

/**
 * Build the synthetic clone RF nodes from the current api RF nodes + branch plan. Lanes
 * fan out horizontally from the original's position; the original's data is cloned with
 * an added `branchLabel`.
 */
export function buildCloneNodes(
  apiRf: RFNode[],
  plan: BranchPlan,
  groups: ExecutionGroup[],
): RFNode[] {
  const desired: RFNode[] = [];
  for (const [gid, branches] of plan.branchesByGroup) {
    const grp = groups.find((g) => g.id === gid);
    if (!grp) continue;
    const N = branches.length;
    for (const nid of grp.nodeIds) {
      const orig = apiRf.find((n) => n.id === nid);
      if (!orig) continue;
      for (let i = 0; i < N; i++) {
        const k = branches[i];
        const offset = (i - (N - 1) / 2) * BRANCH_LANE_SPREAD;
        const niceSegs = k.split('/').map((seg) => prettifySeg(seg, groups));
        desired.push({
          id: branchCloneRfId(nid, k),
          type: 'api',
          position: { x: orig.position.x + offset, y: orig.position.y },
          data: { ...orig.data, branchLabel: niceSegs.join(' › ') },
          draggable: false,
          selectable: true,
        });
      }
    }
  }
  return desired;
}

/**
 * Reconcile current RF nodes with desired clones + hidden state. Returns the SAME array
 * reference when nothing changed so React Flow's internal state bails out.
 */
export function reconcileCloneNodes(
  cur: RFNode[],
  desiredClones: RFNode[],
  inBranchOriginals: Set<string>,
): RFNode[] {
  const existingClones = cur.filter(isBranchCloneRf);
  let cloneSetChanged = existingClones.length !== desiredClones.length;
  if (!cloneSetChanged) {
    for (const d of desiredClones) {
      const found = existingClones.find((n) => n.id === d.id);
      if (!found) { cloneSetChanged = true; break; }
      if (found.position.x !== d.position.x || found.position.y !== d.position.y) {
        cloneSetChanged = true; break;
      }
    }
  }
  let hiddenChanged = false;
  for (const n of cur) {
    if (!isApiRf(n)) continue;
    const shouldHide = inBranchOriginals.has(n.id);
    if (!!n.hidden !== shouldHide) { hiddenChanged = true; break; }
  }
  if (!cloneSetChanged && !hiddenChanged) return cur;
  const others = cur.filter((n) => !isBranchCloneRf(n));
  const updatedOthers = others.map((n) => {
    if (!isApiRf(n)) return n;
    const shouldHide = inBranchOriginals.has(n.id);
    if (!!n.hidden === shouldHide) return n;
    return { ...n, hidden: shouldHide };
  });
  return [...updatedOthers, ...desiredClones];
}

/**
 * Build the synthetic clone edges by walking the canonical edge set + branch plan. Edges
 * crossing the group boundary fan into the branch lanes; cross-group edges (rare) skip.
 */
export function buildCloneEdges(origEdges: RFEdge[], plan: BranchPlan): RFEdge[] {
  const desired: RFEdge[] = [];
  for (const e of origEdges) {
    const uIn = plan.inBranchOriginals.has(e.source);
    const vIn = plan.inBranchOriginals.has(e.target);
    if (!uIn && !vIn) continue;
    const gOfU = plan.inGroupOf.get(e.source);
    const gOfV = plan.inGroupOf.get(e.target);
    let keys: string[] = [];
    if (uIn && vIn && gOfU && gOfV && gOfU.id === gOfV.id) {
      keys = plan.branchesByGroup.get(gOfU.id) ?? [];
    } else if (uIn && !vIn && gOfU) {
      keys = plan.branchesByGroup.get(gOfU.id) ?? [];
    } else if (!uIn && vIn && gOfV) {
      keys = plan.branchesByGroup.get(gOfV.id) ?? [];
    } else {
      continue; // cross-group adjacency — skip in v1
    }
    for (const k of keys) {
      const sourceId = uIn ? branchCloneRfId(e.source, k) : e.source;
      const targetId = vIn ? branchCloneRfId(e.target, k) : e.target;
      desired.push({
        id: branchCloneEdgeId(e.id, k),
        source: sourceId,
        target: targetId,
      });
    }
  }
  return desired;
}

/**
 * Reconcile current RF edges with desired clone edges + hidden originals. Idempotent —
 * returns input array when nothing changed.
 */
export function reconcileCloneEdges(
  cur: RFEdge[],
  desiredCloneEdges: RFEdge[],
  inBranchOriginals: Set<string>,
): RFEdge[] {
  const origEdges = cur.filter((e) => !isBranchCloneEdge(e));
  const updatedOrigs = origEdges.map((e) => {
    const uIn = inBranchOriginals.has(e.source);
    const vIn = inBranchOriginals.has(e.target);
    const shouldHide = uIn || vIn;
    if (!!e.hidden === shouldHide) return e;
    return { ...e, hidden: shouldHide };
  });
  const existingClones = cur.filter(isBranchCloneEdge);
  let cloneSetChanged = existingClones.length !== desiredCloneEdges.length;
  if (!cloneSetChanged) {
    for (const d of desiredCloneEdges) {
      const found = existingClones.find((e) =>
        e.id === d.id && e.source === d.source && e.target === d.target);
      if (!found) { cloneSetChanged = true; break; }
    }
  }
  let hiddenChanged = false;
  for (let i = 0; i < origEdges.length; i++) {
    if (!!origEdges[i].hidden !== !!updatedOrigs[i].hidden) { hiddenChanged = true; break; }
  }
  if (!cloneSetChanged && !hiddenChanged) return cur;
  return [...updatedOrigs, ...desiredCloneEdges];
}
