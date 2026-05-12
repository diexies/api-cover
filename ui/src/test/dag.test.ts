import { describe, it, expect } from 'vitest';
import type { Edge as RFEdge } from '@xyflow/react';
import { wouldCreateCycle } from '../dag';

function edge(source: string, target: string): RFEdge {
  return { id: `${source}->${target}`, source, target };
}

describe('wouldCreateCycle', () => {
  it('returns true for self-loop', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true);
  });

  it('returns false for empty graph forward edge', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });

  it('detects direct cycle b->a when a->b exists', () => {
    const edges = [edge('a', 'b')];
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true);
  });

  it('detects transitive cycle', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    expect(wouldCreateCycle(edges, 'd', 'a')).toBe(true);
  });

  it('allows non-cycle forward edge in DAG', () => {
    const edges = [edge('a', 'b'), edge('a', 'c')];
    expect(wouldCreateCycle(edges, 'b', 'c')).toBe(false);
  });
});
