import { describe, expect, it } from 'vitest';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import {
  buildCloneEdges,
  buildCloneNodes,
  planBranchFanOut,
  reconcileCloneEdges,
  reconcileCloneNodes,
} from './branchClones';
import { branchCloneEdgeId, branchCloneRfId } from './scenarioCanvasUtils';
import type { ExecutionGroup, Run } from '../api';

function apiRf(id: string, x = 0, y = 0): RFNode {
  return { id, type: 'api', position: { x, y }, data: { method: 'GET', path: '/', label: id, status: 'pending', idle: true } } as unknown as RFNode;
}

const G1: ExecutionGroup = {
  id: 'g1', label: 'G1', nodeIds: ['n1', 'n2'],
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  repeat: { count: 2 },
};

function makeRun(branchPaths: string[][]): Run {
  return {
    id: 'r1', scenarioId: 's1', status: 'running', startedAt: '',
    nodeResults: branchPaths.map((bp, i) => ({
      nodeId: i % 2 === 0 ? 'n1' : 'n2',
      status: 'succeeded',
      branchPath: bp,
    })),
  } as unknown as Run;
}

describe('planBranchFanOut', () => {
  it('returns empty plan when run is null', () => {
    const plan = planBranchFanOut(null, [G1]);
    expect(plan.branchesByGroup.size).toBe(0);
    expect(plan.inBranchOriginals.size).toBe(0);
    expect(plan.inGroupOf.get('n1')?.id).toBe('g1');
  });

  it('collects branch keys per group', () => {
    const run = makeRun([['g1#1'], ['g1#2']]);
    const plan = planBranchFanOut(run, [G1]);
    expect(plan.branchesByGroup.get('g1')).toEqual(['g1#1', 'g1#2']);
    expect(plan.inBranchOriginals.has('n1')).toBe(true);
    expect(plan.inBranchOriginals.has('n2')).toBe(true);
  });

  it('skips root nodeResults (empty branchKey)', () => {
    const run = { id: 'r', scenarioId: 's', status: 'running', startedAt: '',
      nodeResults: [{ nodeId: 'n1', status: 'succeeded', branchPath: [] }] } as unknown as Run;
    const plan = planBranchFanOut(run, [G1]);
    expect(plan.branchesByGroup.size).toBe(0);
  });
});

describe('buildCloneNodes', () => {
  it('emits one clone per (member × branch) with horizontal offset', () => {
    const run = makeRun([['g1#1'], ['g1#2']]);
    const plan = planBranchFanOut(run, [G1]);
    const clones = buildCloneNodes([apiRf('n1', 100, 0), apiRf('n2', 300, 0)], plan, [G1]);
    expect(clones).toHaveLength(4); // 2 nodes × 2 branches
    // Offsets centred: (i - (N-1)/2) * SPREAD with N=2 → -140, +140 (SPREAD=280)
    const n1Clones = clones.filter((c) => c.id.startsWith('n1@@')).sort((a, b) => a.position.x - b.position.x);
    expect(n1Clones[0].position.x).toBe(100 - 140);
    expect(n1Clones[1].position.x).toBe(100 + 140);
  });

  it('prettifies branchKey segments in the data label', () => {
    const run = makeRun([['g1#1']]);
    const plan = planBranchFanOut(run, [G1]);
    const clones = buildCloneNodes([apiRf('n1')], plan, [G1]);
    const data = clones[0].data as Record<string, unknown>;
    expect(data.branchLabel).toBe('G1 ×1');
  });
});

describe('reconcileCloneNodes', () => {
  it('returns same array when nothing changed', () => {
    const cur: RFNode[] = [apiRf('n1')];
    const out = reconcileCloneNodes(cur, [], new Set());
    expect(out).toBe(cur);
  });

  it('hides originals when they appear in inBranchOriginals', () => {
    const cur: RFNode[] = [apiRf('n1')];
    const out = reconcileCloneNodes(cur, [], new Set(['n1']));
    expect(out[0].hidden).toBe(true);
  });

  it('appends clones to the end of the node list', () => {
    const cur: RFNode[] = [apiRf('n1')];
    const clone = { id: branchCloneRfId('n1', 'g1#1'), type: 'api', position: { x: 0, y: 0 }, data: {} } as RFNode;
    const out = reconcileCloneNodes(cur, [clone], new Set(['n1']));
    expect(out[out.length - 1].id).toBe(clone.id);
    expect(out.length).toBe(2);
  });
});

describe('buildCloneEdges', () => {
  it('routes edges where one endpoint is inside a branch group', () => {
    const run = makeRun([['g1#1'], ['g1#2']]);
    const plan = planBranchFanOut(run, [G1]);
    const orig: RFEdge[] = [{ id: 'e1', source: 'upstream', target: 'n1' } as RFEdge];
    const clones = buildCloneEdges(orig, plan);
    expect(clones).toHaveLength(2); // one per branch
    expect(clones[0].source).toBe('upstream');
    expect(clones[0].target).toBe(branchCloneRfId('n1', 'g1#1'));
  });

  it('routes intra-group edges through every branch', () => {
    const run = makeRun([['g1#1'], ['g1#2']]);
    const plan = planBranchFanOut(run, [G1]);
    const orig: RFEdge[] = [{ id: 'e1', source: 'n1', target: 'n2' } as RFEdge];
    const clones = buildCloneEdges(orig, plan);
    expect(clones).toHaveLength(2);
    expect(clones[0].source).toBe(branchCloneRfId('n1', 'g1#1'));
    expect(clones[0].target).toBe(branchCloneRfId('n2', 'g1#1'));
  });

  it('skips cross-group edges (no branch context)', () => {
    const run = makeRun([['g1#1']]);
    const plan = planBranchFanOut(run, [G1]);
    // Both endpoints outside the branch group → no clone edges emitted.
    const orig: RFEdge[] = [{ id: 'e1', source: 'x', target: 'y' } as RFEdge];
    expect(buildCloneEdges(orig, plan)).toEqual([]);
  });
});

describe('reconcileCloneEdges', () => {
  it('returns same array when nothing changed', () => {
    const cur: RFEdge[] = [{ id: 'e1', source: 'a', target: 'b' } as RFEdge];
    const out = reconcileCloneEdges(cur, [], new Set());
    expect(out).toBe(cur);
  });

  it('hides originals when an endpoint is in branch fan-out', () => {
    const cur: RFEdge[] = [{ id: 'e1', source: 'a', target: 'n1' } as RFEdge];
    const out = reconcileCloneEdges(cur, [], new Set(['n1']));
    expect(out[0].hidden).toBe(true);
  });

  it('replaces existing clone edges when set changes', () => {
    const oldClone: RFEdge = { id: branchCloneEdgeId('e1', 'g1#1'), source: 'a', target: 'b' } as RFEdge;
    const newClone: RFEdge = { id: branchCloneEdgeId('e1', 'g1#2'), source: 'a', target: 'b' } as RFEdge;
    const cur: RFEdge[] = [oldClone];
    const out = reconcileCloneEdges(cur, [newClone], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(newClone.id);
  });
});
