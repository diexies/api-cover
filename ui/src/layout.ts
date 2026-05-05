import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';

// Auto-layout DAG nodes top-to-bottom using dagre. Pure function; safe to call on every render.
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

export function autoLayout<T extends Node>(nodes: T[], edges: Edge[]): T[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });
}
