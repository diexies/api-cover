// Lightweight SVG mini-map of the selected node's immediate neighborhood.
// Renders selected node centered + upstream nodes on the left + downstream nodes on the right
// + declared dependencies as dashed lines. Click a circle to focus that node in the canvas.

import type { ApiNode } from '../api';

interface Props {
  selfId: string;
  selfMethod: string;
  upstreamIds: string[];
  downstreamIds: string[];
  dependencyIds: string[];
  siblings: ApiNode[];
  onFocus?: (nodeId: string) => void;
}

const W = 240;
const H = 140;
const CY = H / 2;
const SELF_X = W / 2;
const SIDE_X_LEFT = 32;
const SIDE_X_RIGHT = W - 32;
const NODE_R = 7;

export function DependencyGraphMini({
  selfId, selfMethod, upstreamIds, downstreamIds, dependencyIds, siblings, onFocus,
}: Props) {
  const upstream = upstreamIds.map((id) => siblings.find((s) => s.id === id)).filter((n): n is ApiNode => !!n);
  const downstream = downstreamIds.map((id) => siblings.find((s) => s.id === id)).filter((n): n is ApiNode => !!n);
  const deps = dependencyIds
    .filter((id) => !upstreamIds.includes(id) && !downstreamIds.includes(id) && id !== selfId)
    .map((id) => siblings.find((s) => s.id === id))
    .filter((n): n is ApiNode => !!n);

  const upstreamPos = layoutColumn(upstream.length, SIDE_X_LEFT);
  const downstreamPos = layoutColumn(downstream.length, SIDE_X_RIGHT);
  const depPos = layoutColumn(deps.length, SELF_X, H - 18);

  return (
    <svg className="dep-mini" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="dependency mini map">
      {/* Edges: upstream → self */}
      {upstream.map((u, i) => (
        <line
          key={`u-${u.id}`}
          x1={upstreamPos[i].x + NODE_R}
          y1={upstreamPos[i].y}
          x2={SELF_X - NODE_R}
          y2={CY}
          className="dep-edge"
        />
      ))}
      {/* Edges: self → downstream */}
      {downstream.map((d, i) => (
        <line
          key={`d-${d.id}`}
          x1={SELF_X + NODE_R}
          y1={CY}
          x2={downstreamPos[i].x - NODE_R}
          y2={downstreamPos[i].y}
          className="dep-edge"
        />
      ))}
      {/* Edges: declared deps (dashed, below) */}
      {deps.map((dp, i) => (
        <line
          key={`dep-${dp.id}`}
          x1={SELF_X}
          y1={CY + NODE_R}
          x2={depPos[i].x}
          y2={depPos[i].y}
          className="dep-edge dep-edge-dashed"
        />
      ))}

      {/* Self node */}
      <g
        className="dep-node dep-node-self"
        onClick={() => onFocus?.(selfId)}
        style={{ cursor: onFocus ? 'pointer' : 'default' }}
      >
        <rect x={SELF_X - 12} y={CY - 9} width={24} height={18} rx={0} />
        <text x={SELF_X} y={CY + 4} textAnchor="middle" className="dep-method">{selfMethod}</text>
      </g>
      <text x={SELF_X} y={CY + 22} textAnchor="middle" className="dep-label dep-label-self">{truncate(selfId, 14)}</text>

      {/* Upstream nodes */}
      {upstream.map((u, i) => (
        <g
          key={`un-${u.id}`}
          className="dep-node"
          onClick={() => onFocus?.(u.id)}
          style={{ cursor: onFocus ? 'pointer' : 'default' }}
        >
          <circle cx={upstreamPos[i].x} cy={upstreamPos[i].y} r={NODE_R} />
          <text x={upstreamPos[i].x} y={upstreamPos[i].y - NODE_R - 2} textAnchor="middle" className="dep-label">{truncate(u.id, 9)}</text>
        </g>
      ))}

      {/* Downstream nodes */}
      {downstream.map((d, i) => (
        <g
          key={`dn-${d.id}`}
          className="dep-node"
          onClick={() => onFocus?.(d.id)}
          style={{ cursor: onFocus ? 'pointer' : 'default' }}
        >
          <circle cx={downstreamPos[i].x} cy={downstreamPos[i].y} r={NODE_R} />
          <text x={downstreamPos[i].x} y={downstreamPos[i].y - NODE_R - 2} textAnchor="middle" className="dep-label">{truncate(d.id, 9)}</text>
        </g>
      ))}

      {/* Declared deps */}
      {deps.map((dp, i) => (
        <g
          key={`dpn-${dp.id}`}
          className="dep-node dep-node-decl"
          onClick={() => onFocus?.(dp.id)}
          style={{ cursor: onFocus ? 'pointer' : 'default' }}
        >
          <circle cx={depPos[i].x} cy={depPos[i].y} r={NODE_R - 1} />
          <text x={depPos[i].x} y={depPos[i].y - NODE_R - 2} textAnchor="middle" className="dep-label">{truncate(dp.id, 9)}</text>
        </g>
      ))}

      {/* Empty hint */}
      {upstream.length === 0 && downstream.length === 0 && deps.length === 0 && (
        <text x={W / 2} y={H - 8} textAnchor="middle" className="dep-empty">no neighbors</text>
      )}
    </svg>
  );
}

function layoutColumn(count: number, x: number, axisH: number = H): { x: number; y: number }[] {
  if (count === 0) return [];
  if (count === 1) return [{ x, y: CY }];
  const padTop = 18;
  const usable = axisH - padTop * 2;
  const step = usable / (count - 1);
  return Array.from({ length: count }, (_, i) => ({ x, y: padTop + step * i }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
