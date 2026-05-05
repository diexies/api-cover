import type { Edge as RFEdge } from '@xyflow/react';

/**
 * Returns true when adding the edge `from → to` would create a cycle in the existing DAG.
 * Implementation: DFS forward from `to` looking for a path back to `from`.
 */
export function wouldCreateCycle(edges: RFEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const stack = [to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}
