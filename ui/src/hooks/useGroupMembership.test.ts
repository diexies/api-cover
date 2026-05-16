import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Node as RFNode } from '@xyflow/react';
import { useGroupMembership } from './useGroupMembership';
import { groupRfId } from '../canvas/scenarioCanvasUtils';
import type { ExecutionGroup, Run } from '../api';

function apiRfNode(id: string, x: number, y: number): RFNode {
  return { id, type: 'api', position: { x, y }, data: { method: 'GET', path: '/', label: id, status: 'pending', idle: true }, measured: { width: 220, height: 80 } } as unknown as RFNode;
}
function groupRfNode(gid: string, x: number, y: number, w = 600, h = 400): RFNode {
  return { id: groupRfId(gid), type: 'groupArea', position: { x, y }, style: { width: w, height: h }, data: { label: gid, color: '#000', count: 1 } } as unknown as RFNode;
}

describe('useGroupMembership — geometric membership', () => {
  it('writes membership through setGroups on first pass', () => {
    const setNodes = vi.fn();
    const setGroups = vi.fn();
    const groups: ExecutionGroup[] = [{ id: 'g1', label: 'G1', nodeIds: [], bounds: { x: 0, y: 0, width: 600, height: 400 } }];
    const nodes: RFNode[] = [apiRfNode('a', 50, 50), groupRfNode('g1', 0, 0)];
    renderHook(() => useGroupMembership({ nodes, setNodes, setGroups, groups, run: null }));
    expect(setGroups).toHaveBeenCalled();
    const updater = setGroups.mock.calls[0][0] as (g: ExecutionGroup[]) => ExecutionGroup[];
    const next = updater(groups);
    expect(next[0].nodeIds).toEqual(['a']);
  });
});

describe('useGroupMembership — iteration tally', () => {
  it('writes tally fields into group RF nodes when a run is present', () => {
    const setNodes = vi.fn();
    const setGroups = vi.fn();
    const groups: ExecutionGroup[] = [
      { id: 'g1', label: 'G1', nodeIds: ['n1'], bounds: { x: 0, y: 0, width: 1, height: 1 }, repeat: { count: 3 } },
    ];
    const nodes: RFNode[] = [groupRfNode('g1', 0, 0)];
    const run: Run = {
      id: 'r1',
      scenarioId: 's1',
      status: 'running',
      startedAt: '',
      nodeResults: [
        { nodeId: 'n1', status: 'succeeded', branchPath: ['g1#1'] },
        { nodeId: 'n1', status: 'running', branchPath: ['g1#2'] },
      ],
    } as unknown as Run;
    renderHook(() => useGroupMembership({ nodes, setNodes, setGroups, groups, run }));
    // setNodes is called twice (membership + tally). Inspect the tally updater (second call).
    expect(setNodes).toHaveBeenCalled();
    const updater = setNodes.mock.calls[setNodes.mock.calls.length - 1][0] as (cur: RFNode[]) => RFNode[];
    const next = updater(nodes);
    const groupNode = next.find((n) => n.id === groupRfId('g1'));
    const data = groupNode!.data as Record<string, unknown>;
    expect(data.runningIter).toBe(2);
    expect(data.totalIter).toBe(3);
    expect(data.iterPassed).toBe(1);
    expect(data.iterFailed).toBe(0);
    expect(data.isRunning).toBe(true);
  });

  it('returns same RF nodes reference when tally unchanged', () => {
    const setNodes = vi.fn();
    const groups: ExecutionGroup[] = [
      { id: 'g1', label: 'G1', nodeIds: [], bounds: { x: 0, y: 0, width: 1, height: 1 }, repeat: { count: 1 } },
    ];
    // Pre-populate the group RF node with matching tally state so the updater bails.
    const groupNode = {
      ...groupRfNode('g1', 0, 0),
      data: { label: 'G1', color: '#000', count: 1, runningIter: 0, totalIter: 1, iterPassed: 0, iterFailed: 0, isRunning: false },
    } as unknown as RFNode;
    const nodes: RFNode[] = [groupNode];
    renderHook(() => useGroupMembership({ nodes, setNodes, setGroups: vi.fn(), groups, run: null }));
    const updater = setNodes.mock.calls[setNodes.mock.calls.length - 1][0] as (cur: RFNode[]) => RFNode[];
    const next = updater(nodes);
    expect(next).toBe(nodes);
  });
});
