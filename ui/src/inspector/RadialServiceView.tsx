import { useMemo, useState } from 'react';
import type { ServiceMap, ServiceMapEdge, ServiceMapNode } from '../api';

interface Props {
  map: ServiceMap;
  /** Endpoint id at the centre of the diagram. Forward view: shows everything reachable. */
  endpointId: string;
  /** Optional callback when user clicks a node — for cross-panel selection. */
  onNodeClick?: (nodeId: string) => void;
  /** Layout knobs. Defaults render comfortably at 720×640. */
  width?: number;
  height?: number;
}

interface PlacedNode {
  node: ServiceMapNode;
  x: number;
  y: number;
  ring: number;
}

/**
 * Concentric-ring radial diagram. The selected endpoint sits at the centre. Every
 * service / external / database node reachable downstream is placed on a ring
 * indexed by BFS depth — deeper calls live further out. Edges are SVG paths from
 * caller to callee. Hover a node to highlight only the paths that flow through it.
 *
 * No XyFlow, no force layout — pure SVG. This keeps the visual deterministic and
 * reproducible across renders, which matters because the canvas doubles as a
 * snapshot artifact (used in agent memory and screenshots).
 */
export function RadialServiceView({ map, endpointId, onNodeClick, width = 720, height = 640 }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const placement = useMemo(() => buildPlacement(map, endpointId, width, height), [map, endpointId, width, height]);
  const subgraphEdges = useMemo(() => filterEdges(map.edges, placement.placedById), [map.edges, placement.placedById]);

  const cx = width / 2;
  const cy = height / 2;
  const maxCoupling = Math.max(1, ...map.nodes.map((n) => n.metrics.coupling));

  // When a node is hovered, dim everything not on a path from the centre to that node.
  const highlightSet = useMemo(() => {
    if (!hoverId) return null;
    return computeHighlight(hoverId, endpointId, subgraphEdges);
  }, [hoverId, endpointId, subgraphEdges]);

  return (
    <svg className="radial-service-view" viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="radial-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/* Ring guides */}
      {placement.ringRadii.map((r, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeDasharray="2 4"
          strokeWidth={1}
          opacity={0.4}
        />
      ))}

      {/* Edges */}
      <g className="radial-edges">
        {subgraphEdges.map((e, i) => {
          const from = placement.placedById.get(e.from);
          const to = placement.placedById.get(e.to);
          if (!from || !to) return null;
          const dim = highlightSet && !(highlightSet.has(e.from) && highlightSet.has(e.to));
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className={`radial-edge edge-${e.kind}${dim ? ' dim' : ''}`}
              markerEnd="url(#radial-arrow)"
            />
          );
        })}
      </g>

      {/* Nodes */}
      <g className="radial-nodes">
        {placement.nodes.map((p) => {
          const isCenter = p.node.id === endpointId;
          const dim = highlightSet && !highlightSet.has(p.node.id);
          const tone = couplingTone(p.node.metrics.coupling, maxCoupling);
          return (
            <g
              key={p.node.id}
              transform={`translate(${p.x}, ${p.y})`}
              className={`radial-node kind-${p.node.kind}${isCenter ? ' is-center' : ''}${dim ? ' dim' : ''}`}
              onMouseEnter={() => setHoverId(p.node.id)}
              onMouseLeave={() => setHoverId((h) => (h === p.node.id ? null : h))}
              onClick={() => onNodeClick?.(p.node.id)}
            >
              <ChipShape node={p.node} tone={tone} isCenter={isCenter} />
              <text
                className="radial-node-label"
                textAnchor="middle"
                dy={isCenter ? 5 : 4}
              >
                {labelFor(p.node)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

interface PlacementResult {
  nodes: PlacedNode[];
  placedById: Map<string, PlacedNode>;
  ringRadii: number[];
}

/**
 * BFS from the endpoint over the directed edge set, assigning each reachable node a
 * ring (BFS depth). Externals/DBs always sit one ring outside their last service to
 * keep the leaf boundary visually distinct.
 */
function buildPlacement(map: ServiceMap, endpointId: string, width: number, height: number): PlacementResult {
  const cx = width / 2;
  const cy = height / 2;

  const adj = new Map<string, string[]>();
  for (const e of map.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const depth = new Map<string, number>([[endpointId, 0]]);
  const queue: string[] = [endpointId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  const nodeById = new Map(map.nodes.map((n) => [n.id, n] as const));
  const reachable = Array.from(depth.keys()).map((id) => nodeById.get(id)).filter((n): n is ServiceMapNode => !!n);

  // Promote externals/dbs to be at least one ring further than the deepest service.
  const maxServiceDepth = reachable.reduce((acc, n) => {
    if (n.kind === 'service' || n.kind === 'endpoint') return Math.max(acc, depth.get(n.id) ?? 0);
    return acc;
  }, 0);
  for (const n of reachable) {
    if (n.kind === 'externalHttp' || n.kind === 'database') {
      const d = depth.get(n.id) ?? maxServiceDepth + 1;
      depth.set(n.id, Math.max(d, maxServiceDepth + 1));
    }
  }

  // Group by ring.
  const byRing = new Map<number, ServiceMapNode[]>();
  for (const n of reachable) {
    const d = depth.get(n.id)!;
    if (!byRing.has(d)) byRing.set(d, []);
    byRing.get(d)!.push(n);
  }
  const ringIndices = Array.from(byRing.keys()).sort((a, b) => a - b);
  const maxRing = ringIndices[ringIndices.length - 1] ?? 0;

  // Outer-ring radius leaves margin for chip width.
  const maxRadius = Math.min(width, height) / 2 - 80;
  const ringRadii = ringIndices.map((i) => (maxRing === 0 ? 0 : (i / maxRing) * maxRadius));

  const placed: PlacedNode[] = [];
  for (let r = 0; r < ringIndices.length; r++) {
    const ring = ringIndices[r];
    const nodes = byRing.get(ring)!.slice().sort((a, b) => a.label.localeCompare(b.label));
    const radius = ringRadii[r];
    if (radius === 0) {
      placed.push({ node: nodes[0], x: cx, y: cy, ring: 0 });
      continue;
    }
    const startAngle = -Math.PI / 2;
    for (let i = 0; i < nodes.length; i++) {
      const angle = startAngle + (i / nodes.length) * 2 * Math.PI;
      placed.push({
        node: nodes[i],
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        ring,
      });
    }
  }

  return {
    nodes: placed,
    placedById: new Map(placed.map((p) => [p.node.id, p] as const)),
    ringRadii: ringRadii.filter((r) => r > 0),
  };
}

function filterEdges(edges: ServiceMapEdge[], placedById: Map<string, unknown>): ServiceMapEdge[] {
  return edges.filter((e) => placedById.has(e.from) && placedById.has(e.to));
}

function computeHighlight(focusId: string, endpointId: string, edges: ServiceMapEdge[]): Set<string> {
  // Highlight the union of (paths from endpoint downstream to focus) and (everything reachable from focus).
  const result = new Set<string>([focusId]);

  const reverse = new Map<string, string[]>();
  const forward = new Map<string, string[]>();
  for (const e of edges) {
    (forward.get(e.from) ?? forward.set(e.from, []).get(e.from)!).push(e.to);
    (reverse.get(e.to) ?? reverse.set(e.to, []).get(e.to)!).push(e.from);
  }

  // BFS upstream from focus to find ancestors back to endpoint.
  const upQueue = [focusId];
  while (upQueue.length > 0) {
    const cur = upQueue.shift()!;
    for (const prev of reverse.get(cur) ?? []) {
      if (!result.has(prev)) {
        result.add(prev);
        upQueue.push(prev);
      }
    }
  }

  // BFS downstream from focus to leaves.
  const downQueue = [focusId];
  while (downQueue.length > 0) {
    const cur = downQueue.shift()!;
    for (const next of forward.get(cur) ?? []) {
      if (!result.has(next)) {
        result.add(next);
        downQueue.push(next);
      }
    }
  }

  result.add(endpointId);
  return result;
}

function ChipShape({ node, tone, isCenter }: { node: ServiceMapNode; tone: string; isCenter: boolean }) {
  const w = isCenter ? 168 : nodeWidth(node);
  const h = isCenter ? 44 : 30;
  const fillVar = isCenter ? 'var(--accent)' : `var(${tone})`;
  const stroke = isCenter ? 'var(--accent)' : 'var(--border)';
  return (
    <>
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={isCenter ? 10 : 8}
        ry={isCenter ? 10 : 8}
        className="radial-node-shape"
        style={{ fill: fillVar, stroke, strokeWidth: isCenter ? 2 : 1 }}
      />
      <KindIcon kind={node.kind} x={-w / 2 + 8} />
    </>
  );
}

function KindIcon({ kind, x }: { kind: ServiceMapNode['kind']; x: number }) {
  const icon = kind === 'externalHttp' ? '🌐'
    : kind === 'database' ? '💾'
    : kind === 'endpoint' ? '⚡'
    : '⊟';
  return (
    <text x={x} y={4} className="radial-node-icon" textAnchor="start" fontSize="11">{icon}</text>
  );
}

function nodeWidth(n: ServiceMapNode): number {
  const len = labelFor(n).length;
  return Math.max(70, Math.min(200, len * 7 + 28));
}

function labelFor(n: ServiceMapNode): string {
  if (n.kind === 'endpoint') {
    return `${n.httpMethod ?? ''} ${n.label}`.trim();
  }
  return n.label;
}

function couplingTone(value: number, max: number): string {
  if (value <= 0) return '--node-tone-cool';
  const ratio = value / max;
  if (ratio < 0.34) return '--node-tone-cool';
  if (ratio < 0.67) return '--node-tone-warm';
  return '--node-tone-hot';
}
