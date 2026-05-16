import { describe, expect, it } from 'vitest';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import type { EndpointDescriptor, Run, Scenario } from '../api';
import {
  aggregateBranchStatus,
  branchCloneEdgeId,
  branchCloneRfId,
  buildFromScenario,
  caseIdFromRf,
  caseRfId,
  collectDescendants,
  formatAgo,
  groupHashClass,
  groupIdFromRf,
  groupRfId,
  isApiRf,
  isBranchCloneEdge,
  isBranchCloneRf,
  isCaseRfNode,
  isGroupRfNode,
  isStructuralRf,
  nextNodeId,
  parseBranchCloneRf,
  seedFromEndpoint,
} from './scenarioCanvasUtils';

describe('RF id codecs', () => {
  it('group id round-trip', () => {
    const rf = groupRfId('g1');
    expect(rf).toBe('group::g1');
    expect(groupIdFromRf(rf)).toBe('g1');
    expect(isGroupRfNode({ id: rf } as RFNode)).toBe(true);
    expect(isGroupRfNode({ id: 'g1' } as RFNode)).toBe(false);
  });

  it('case id round-trip', () => {
    const rf = caseRfId('c1');
    expect(rf).toBe('case::c1');
    expect(caseIdFromRf(rf)).toBe('c1');
    expect(isCaseRfNode({ id: rf } as RFNode)).toBe(true);
  });

  it('structural detector covers groups and cases', () => {
    expect(isStructuralRf({ id: 'group::a' } as RFNode)).toBe(true);
    expect(isStructuralRf({ id: 'case::b' } as RFNode)).toBe(true);
    expect(isStructuralRf({ id: 'plain' } as RFNode)).toBe(false);
  });

  it('branch clone id round-trip', () => {
    const rf = branchCloneRfId('login', 'v1');
    expect(rf).toBe('login@@v1');
    const parsed = parseBranchCloneRf(rf);
    expect(parsed).toEqual({ nodeId: 'login', branchKey: 'v1' });
    expect(isBranchCloneRf({ id: rf } as RFNode)).toBe(true);
    expect(isBranchCloneRf({ id: 'login' } as RFNode)).toBe(false);
  });

  it('parseBranchCloneRf returns null when separator absent', () => {
    expect(parseBranchCloneRf('plain')).toBeNull();
  });

  it('branch clone edge id and detector', () => {
    const eid = branchCloneEdgeId('e-1-a-b', 'v2');
    expect(eid).toBe('bedge::v2::e-1-a-b');
    expect(isBranchCloneEdge({ id: eid } as RFEdge)).toBe(true);
    expect(isBranchCloneEdge({ id: 'e-1' } as RFEdge)).toBe(false);
  });

  it('isApiRf excludes structural and branch clones', () => {
    expect(isApiRf({ id: 'login' } as RFNode)).toBe(true);
    expect(isApiRf({ id: 'group::a' } as RFNode)).toBe(false);
    expect(isApiRf({ id: 'case::a' } as RFNode)).toBe(false);
    expect(isApiRf({ id: 'login@@v1' } as RFNode)).toBe(false);
  });
});

describe('nextNodeId', () => {
  it('returns slug when no collision', () => {
    // Regex collapses non-alphanumerics into single underscores per char run, but slashes
    // produce a leading underscore so "get_/users" becomes "get__users".
    expect(nextNodeId([], 'GET', '/users')).toBe('get__users');
  });

  it('suffixes with index on collision', () => {
    const existing = [{ id: 'get__users' }] as RFNode[];
    expect(nextNodeId(existing, 'GET', '/users')).toBe('get__users_2');
  });

  it('keeps incrementing past taken suffixes', () => {
    const existing = [
      { id: 'get__users' },
      { id: 'get__users_2' },
      { id: 'get__users_3' },
    ] as RFNode[];
    expect(nextNodeId(existing, 'GET', '/users')).toBe('get__users_4');
  });

  it('strips path placeholder braces', () => {
    // Braces stripped first; remaining slashes/separators collapse to underscores.
    expect(nextNodeId([], 'POST', '/orders/{id}/items')).toBe('post__orders_id_items');
  });
});

describe('seedFromEndpoint', () => {
  const baseEp = {
    id: 'POST /users/{id:int}',
    method: 'post',
    path: '/users/{id:int}',
    parameters: [
      { name: 'id', in: 'path', defaultValue: 1 },
      { name: 'filter', in: 'query' },
      { name: 'X-Trace', in: 'header', defaultValue: 'abc' },
    ],
  } as unknown as EndpointDescriptor;

  it('seeds path/query/header defaults', () => {
    const node = seedFromEndpoint('n1', baseEp);
    expect(node.id).toBe('n1');
    expect(node.method).toBe('POST');
    expect(node.path).toBe('/users/{id}'); // normalisePath strips constraint
    expect(node.pathParameters).toEqual({ id: 1 });
    expect(node.queryParameters).toEqual({ filter: '' });
    expect(node.headers).toEqual({ 'X-Trace': 'abc' });
  });

  it('uses sample JSON payload for body when present', () => {
    const ep = {
      ...baseEp,
      samples: [{ name: 'sample-1', jsonPayload: '{"name":"alice"}' }],
    } as unknown as EndpointDescriptor;
    const node = seedFromEndpoint('n', ep);
    expect(node.body).toEqual({ name: 'alice' });
  });

  it('falls back to requestBody example when no sample', () => {
    const ep = {
      ...baseEp,
      requestBody: { content: [{ contentType: 'application/json', example: { x: 1 } }] },
    } as unknown as EndpointDescriptor;
    const node = seedFromEndpoint('n', ep);
    expect(node.body).toEqual({ x: 1 });
  });
});

describe('collectDescendants', () => {
  it('returns just anchor when no outgoing edges', () => {
    expect(collectDescendants('a', [])).toEqual(new Set(['a']));
  });

  it('walks transitively via BFS', () => {
    const edges = [
      { id: '1', source: 'a', target: 'b' },
      { id: '2', source: 'b', target: 'c' },
      { id: '3', source: 'a', target: 'd' },
    ] as RFEdge[];
    expect(collectDescendants('a', edges)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('handles cycles without looping', () => {
    const edges = [
      { id: '1', source: 'a', target: 'b' },
      { id: '2', source: 'b', target: 'a' },
    ] as RFEdge[];
    expect(collectDescendants('a', edges)).toEqual(new Set(['a', 'b']));
  });
});

describe('groupHashClass', () => {
  it('returns deterministic bucket in [0, 6)', () => {
    for (const id of ['a', 'group-1', 'long-string-xyz']) {
      const v = groupHashClass(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });

  it('is stable across calls', () => {
    expect(groupHashClass('g1')).toBe(groupHashClass('g1'));
  });
});

describe('aggregateBranchStatus', () => {
  function makeRun(results: Array<{ status: string; nodeId: string; branchPath?: string[] }>): Run {
    return { id: 'r1', scenarioId: 's1', status: 'running', startedAt: '', nodeResults: results as never } as Run;
  }

  it('returns pending when run is null', () => {
    expect(aggregateBranchStatus(null, 'v1')).toBe('pending');
  });

  it('running takes precedence', () => {
    const run = makeRun([
      { nodeId: 'a', status: 'succeeded', branchPath: ['v1'] },
      { nodeId: 'b', status: 'running', branchPath: ['v1'] },
    ]);
    expect(aggregateBranchStatus(run, 'v1')).toBe('running');
  });

  it('failed beats succeeded', () => {
    const run = makeRun([
      { nodeId: 'a', status: 'succeeded', branchPath: ['v1'] },
      { nodeId: 'b', status: 'failed', branchPath: ['v1'] },
    ]);
    expect(aggregateBranchStatus(run, 'v1')).toBe('failed');
  });

  it('all succeeded → succeeded', () => {
    const run = makeRun([
      { nodeId: 'a', status: 'succeeded', branchPath: ['v1'] },
      { nodeId: 'b', status: 'succeeded', branchPath: ['v1'] },
    ]);
    expect(aggregateBranchStatus(run, 'v1')).toBe('succeeded');
  });

  it('empty results for key → pending', () => {
    const run = makeRun([{ nodeId: 'a', status: 'succeeded', branchPath: ['vOther'] }]);
    expect(aggregateBranchStatus(run, 'v1')).toBe('pending');
  });
});

describe('formatAgo', () => {
  it('returns "just now" under 5s', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(4_999)).toBe('just now');
  });

  it('seconds branch', () => {
    expect(formatAgo(10_000)).toBe('10s ago');
  });

  it('minutes branch', () => {
    expect(formatAgo(2 * 60_000)).toBe('2m ago');
  });

  it('hours branch', () => {
    expect(formatAgo(3 * 60 * 60_000)).toBe('3h ago');
  });
});

describe('buildFromScenario', () => {
  it('builds RF nodes/edges from a scenario shape', () => {
    const scenario: Scenario = {
      id: 's1',
      name: 'S1',
      nodes: [
        { id: 'a', method: 'GET', path: '/a', position: { x: 0, y: 0 } },
        { id: 'b', method: 'POST', path: '/b', position: { x: 200, y: 0 } },
      ],
      edges: [{ from: 'a', to: 'b' }],
      groups: [],
    } as Scenario;
    const out = buildFromScenario(scenario);
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].source).toBe('a');
    expect(out.edges[0].target).toBe('b');
  });

  it('filters stale branch-clone edges referencing missing ids', () => {
    const scenario: Scenario = {
      id: 's1',
      name: 'S1',
      nodes: [{ id: 'a', method: 'GET', path: '/a', position: { x: 0, y: 0 } }],
      edges: [
        { from: 'a', to: 'a@@v1' }, // clone leak
        { from: 'a', to: 'b' },     // missing target
      ],
      groups: [],
    } as Scenario;
    const out = buildFromScenario(scenario);
    expect(out.edges).toHaveLength(0);
  });

  it('emits group nodes with derived colour when bounds present', () => {
    const scenario: Scenario = {
      id: 's1',
      name: 'S1',
      nodes: [{ id: 'a', method: 'GET', path: '/a', position: { x: 0, y: 0 } }],
      edges: [],
      groups: [{
        id: 'g1',
        label: 'G1',
        nodeIds: ['a'],
        bounds: { x: 0, y: 0, width: 200, height: 100 },
      }],
    } as Scenario;
    const out = buildFromScenario(scenario);
    expect(out.nodes.map((n) => n.id)).toContain('group::g1');
  });
});
