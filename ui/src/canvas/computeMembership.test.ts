import { describe, expect, it } from 'vitest';
import { computeMembership, type ApiNodeSample, type GroupSample, type Rect } from './computeMembership';
import type { ExecutionGroup } from '../api';

function group(id: string, bounds: Rect, nodeIds: string[] = []): ExecutionGroup {
  return { id, label: id, bounds, nodeIds };
}

function api(id: string, x: number, y: number): ApiNodeSample {
  return { id, x, y, w: 100, h: 50 };
}

function groupSample(id: string, bounds: Rect): GroupSample {
  return { id, bounds };
}

const GROUP_A: Rect = { x: 0, y: 0, width: 400, height: 200 };

describe('computeMembership', () => {
  it('initial pass computes membership from positions', () => {
    const inside = api('n1', 50, 50);
    const outside = api('n2', 500, 500);
    const out = computeMembership({
      apiNodes: [inside, outside],
      groupSamples: [groupSample('g1', GROUP_A)],
      groups: [group('g1', GROUP_A)],
      prevPositions: new Map(),
      prevGroupBounds: new Map(),
    });
    expect(out.groups[0].nodeIds).toEqual(['n1']);
    expect(out.nextPositions.get('n1')).toBeDefined();
    expect(out.nextGroupBounds.get('g1')).toEqual(GROUP_A);
  });

  it('returns same reference when nothing changed (fast path)', () => {
    const groups = [group('g1', GROUP_A, ['n1'])];
    const prevPositions = new Map([['n1', { x: 50, y: 50, width: 100, height: 50 }]]);
    const prevGroupBounds = new Map([['g1', GROUP_A]]);
    const out = computeMembership({
      apiNodes: [api('n1', 50, 50)],
      groupSamples: [groupSample('g1', GROUP_A)],
      groups,
      prevPositions,
      prevGroupBounds,
    });
    expect(out.groups).toBe(groups);
  });

  it('updates membership when a node crosses out of a group', () => {
    const groups = [group('g1', GROUP_A, ['n1'])];
    const prevPositions = new Map([['n1', { x: 50, y: 50, width: 100, height: 50 }]]);
    const prevGroupBounds = new Map([['g1', GROUP_A]]);
    const out = computeMembership({
      apiNodes: [api('n1', 800, 800)], // moved outside
      groupSamples: [groupSample('g1', GROUP_A)],
      groups,
      prevPositions,
      prevGroupBounds,
    });
    expect(out.groups).not.toBe(groups);
    expect(out.groups[0].nodeIds).toEqual([]);
  });

  it('skips groups whose neighbourhood did not move', () => {
    const farGroup: Rect = { x: 5000, y: 5000, width: 200, height: 200 };
    const groupNear = group('near', GROUP_A, []);
    const groupFar = group('far', farGroup, ['nFar']);
    const groups = [groupNear, groupFar];
    const prevPositions = new Map([
      ['nMove', { x: 50, y: 50, width: 100, height: 50 }],
      ['nFar', { x: 5050, y: 5050, width: 100, height: 50 }],
    ]);
    const prevGroupBounds = new Map([['near', GROUP_A], ['far', farGroup]]);
    const out = computeMembership({
      apiNodes: [api('nMove', 60, 60), api('nFar', 5050, 5050)], // only nMove changed, near group
      groupSamples: [groupSample('near', GROUP_A), groupSample('far', farGroup)],
      groups,
      prevPositions,
      prevGroupBounds,
    });
    // Far group's reference must be preserved (no work done on it)
    expect(out.groups[1]).toBe(groupFar);
  });

  it('drops a group whose RF node was removed', () => {
    const groups = [group('g1', GROUP_A, ['n1']), group('gGone', { x: 0, y: 0, width: 1, height: 1 }, [])];
    const out = computeMembership({
      apiNodes: [api('n1', 50, 50)],
      groupSamples: [groupSample('g1', GROUP_A)], // gGone missing
      groups,
      prevPositions: new Map([['n1', { x: 50, y: 50, width: 100, height: 50 }]]),
      prevGroupBounds: new Map([['g1', GROUP_A], ['gGone', { x: 0, y: 0, width: 1, height: 1 }]]),
    });
    expect(out.groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('detects group bounds resize and recomputes that group', () => {
    const smaller: Rect = { x: 0, y: 0, width: 60, height: 60 };
    const groups = [group('g1', GROUP_A, ['n1'])]; // n1 was inside the larger bounds
    const out = computeMembership({
      apiNodes: [api('n1', 100, 100)], // node didn't move but bounds shrunk
      groupSamples: [groupSample('g1', smaller)],
      groups,
      prevPositions: new Map([['n1', { x: 100, y: 100, width: 100, height: 50 }]]),
      prevGroupBounds: new Map([['g1', GROUP_A]]),
    });
    expect(out.groups[0].nodeIds).toEqual([]);
    expect(out.groups[0].bounds).toEqual(smaller);
  });
});
