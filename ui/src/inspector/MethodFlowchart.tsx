import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import dagre from 'dagre';
import { type FlowchartResult, type FlowchartNode, type FlowchartEdge, getMethodFlowchart } from '../api';

/**
 * Method control-flow diagram rendered with @xyflow/react. The backend returns a node/edge
 * list; we layout with dagre TB and render custom shapes per node.type:
 *   - start / end: rounded stadium
 *   - process: rectangle
 *   - decision: diamond (clip-path)
 *   - loop: diamond with hatched border to distinguish from decision
 *   - catch / finally: red-bordered rectangle
 * Edges are solid by default; dashed for try→catch exception arcs.
 */
export function MethodFlowchart({ path, line }: { path: string; line: number }) {
  const [data, setData] = useState<FlowchartResult | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    getMethodFlowchart(path, line)
      .then((r) => { if (alive) setData(r); })
      .catch((e: Error) => { if (alive) setData({ language: 'csharp', nodes: [], edges: [], truncated: false, error: e.message }); });
    return () => { alive = false; };
  }, [path, line]);

  const { nodes, edges } = useMemo(() => {
    if (!data || data.nodes.length === 0) return { nodes: [] as Node[], edges: [] as Edge[] };
    return layoutGraph(data.nodes, data.edges);
  }, [data]);

  if (!data) return <div className="method-flowchart-empty muted small">loading flowchart…</div>;
  if (data.error) return <div className="method-flowchart-empty muted small">flowchart unavailable: {data.error}</div>;
  if (data.nodes.length === 0) return <div className="method-flowchart-empty muted small">empty method body</div>;

  return (
    <div className="method-flowchart">
      {data.truncated && <div className="method-flowchart-truncated">method too large — diagram truncated at 200 nodes</div>}
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} color="#1f2024" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 60;
const DIAMOND = 140;

function layoutGraph(rawNodes: FlowchartNode[], rawEdges: FlowchartEdge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of rawNodes) {
    let w: number;
    let h: number;
    if (n.type === 'decision') { w = DIAMOND; h = DIAMOND; }
    else if (n.type === 'start') {
      w = Math.max(180, n.label.length * 9 + 40);   // grow to fit the method name
      h = 48;
    } else if (n.type === 'end') {
      w = 160; h = 40;                               // compact pill, chip only
    } else { w = NODE_WIDTH; h = NODE_HEIGHT; }
    g.setNode(n.id, { width: w, height: h });
  }
  for (const e of rawEdges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const nodes: Node[] = rawNodes.map((n) => {
    const pos = g.node(n.id);
    const size = g.node(n.id);
    return {
      id: n.id,
      type: n.type,
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      data: { label: n.label, fullLabel: n.fullLabel, line: n.line, kind: n.kind, varName: n.varName },
      style: n.type === 'start' ? { width: size.width, height: size.height } : undefined,
    };
  });

  const edges: Edge[] = rawEdges.map((e) => {
    const color = edgeColor(e.label, e.dashed);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? undefined,
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: '#0c0d0f', stroke: color, strokeWidth: 1 },
      labelStyle: { fill: color, fontSize: 11, fontStyle: 'italic', fontWeight: 600 },
      style: e.dashed
        ? { stroke: color, strokeDasharray: '5 4', strokeWidth: 1.5 }
        : { stroke: color, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });

  return { nodes, edges };
}

function edgeColor(label: string | null | undefined, dashed: boolean): string {
  if (dashed) return '#c87a7a';                  // try → catch (exception arc, muted red)
  if (!label) return '#5a5d63';                  // unconditional / fall-through
  const l = label.toLowerCase();
  // true / false are two branches, not good/bad. Muted cyan + muted magenta read
  // as paired alternatives without implying a "happy" vs "sad" path.
  if (l === 'true') return '#7aa6c4';            // muted cyan-blue
  if (l === 'false') return '#b87ac4';           // muted magenta
  if (l === 'loop') return '#5b8fb8';            // body iteration
  if (l === 'exit') return '#6b7280';            // loop exit
  if (l === 'throw') return '#c87a7a';
  if (l === 'default') return '#b89a5b';
  return '#8a8d93';                              // switch case literals etc
}

function NodeShell({ children, className, title }: { children: React.ReactNode; className: string; title?: string }) {
  return (
    <div className={`method-flowchart-node ${className}`} title={title}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="method-flowchart-node-body">{children}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}

function StartNode({ data }: NodeProps) {
  const d = data as { label?: string };
  return (
    <div className="method-flowchart-node method-flowchart-node-start">
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="method-flowchart-tag method-flowchart-tag-start">
        <span className="method-flowchart-tag-badge tag-start">F</span>
        <span className="method-flowchart-tag-var">Function Start</span>
      </div>
      <div className="method-flowchart-node-body">{String(d.label ?? 'start')}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}
function EndNode() {
  return (
    <div className="method-flowchart-node method-flowchart-node-end is-end-compact">
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <span className="method-flowchart-tag-badge tag-end">E</span>
      <span className="method-flowchart-tag-var">Function End</span>
    </div>
  );
}
function ProcessNode({ data }: NodeProps) {
  const d = data as { label?: string; fullLabel?: string; kind?: string | null; varName?: string };
  const tag = kindTag(d.kind);
  return (
    <div className={`method-flowchart-node method-flowchart-node-process${d.kind ? ` is-kind-${d.kind}` : ''}`} title={d.fullLabel}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      {tag && (
        <div className="method-flowchart-tag">
          <span className={`method-flowchart-tag-badge tag-${tag.cls}`}>{tag.letter}</span>
          {d.varName && <span className="method-flowchart-tag-var">{d.varName}</span>}
          {!d.varName && tag.label && <span className="method-flowchart-tag-var">{tag.label}</span>}
        </div>
      )}
      <div className="method-flowchart-node-body">{String(d.label ?? '')}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}

function kindTag(kind: string | null | undefined): { letter: string; cls: string; label?: string } | null {
  switch (kind) {
    case 'assignment': return { letter: 'A', cls: 'assignment' };
    case 'return': return { letter: 'R', cls: 'return', label: 'return' };
    case 'throw': return { letter: 'T', cls: 'throw', label: 'throw' };
    case 'call': return { letter: 'C', cls: 'call' };
    case 'loopGoto': return { letter: '↺', cls: 'loop-goto', label: 'iterate' };
    default: return null;
  }
}
function DecisionNode({ data }: NodeProps) {
  const d = data as { label?: string; fullLabel?: string };
  const isSwitch = String(d.label ?? '').trimStart().startsWith('switch');
  return (
    <div className="method-flowchart-node method-flowchart-node-decision" title={d.fullLabel}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="method-flowchart-tag method-flowchart-tag-decision">
        <span className={`method-flowchart-tag-badge tag-${isSwitch ? 'switch' : 'if'}`}>{isSwitch ? 'S' : '?'}</span>
        <span className="method-flowchart-tag-var">{isSwitch ? 'Switch' : 'Condition'}</span>
      </div>
      <div className="method-flowchart-node-body">{String(d.label ?? '')}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}
function LoopNode({ data }: NodeProps) {
  const d = data as { label?: string; fullLabel?: string };
  return (
    <div className="method-flowchart-node method-flowchart-node-loop" title={d.fullLabel}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="method-flowchart-tag">
        <span className="method-flowchart-tag-badge tag-loop">L</span>
        <span className="method-flowchart-tag-var">Loop</span>
      </div>
      <div className="method-flowchart-node-body">{String(d.label ?? '')}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}
function CatchNode({ data }: NodeProps) {
  const d = data as { label?: string };
  return <NodeShell className="method-flowchart-node-catch">{String(d.label ?? 'catch')}</NodeShell>;
}
function FinallyNode({ data }: NodeProps) {
  const d = data as { label?: string };
  return <NodeShell className="method-flowchart-node-finally">{String(d.label ?? 'finally')}</NodeShell>;
}

const NODE_TYPES = {
  start: StartNode,
  end: EndNode,
  process: ProcessNode,
  decision: DecisionNode,
  loop: LoopNode,
  catch: CatchNode,
  finally: FinallyNode,
};
