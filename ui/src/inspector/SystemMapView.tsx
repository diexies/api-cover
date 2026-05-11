import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceMap, ServiceMapEdge, ServiceMapNode, ServiceMapNodeKind } from '../api';

interface Props {
  map: ServiceMap;
  visibleKinds: ReadonlySet<ServiceMapNodeKind>;
  search?: string;
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  width?: number;
  height?: number;
}

interface Vec { x: number; y: number; vx: number; vy: number }
interface Transform { tx: number; ty: number; scale: number }

// Force-simulation tuning. Tuned for 20-100 nodes; tweak in pairs if you change one.
const REPEL = 8000;
const SPRING_K = 0.04;
const REST_BASE = 140;
const DAMPING = 0.85;
const DT = 1.0;
const MAX_VEL = 30;
const EPS = 0.5;
// Concentric tier layout. Each BFS level lives on its own ring. Radial bias
// pulls each node back to its target ring; angular position is left to the
// repulsion + spring tug-of-war so the layout still self-organises.
const RING_GAP = 130;
const RING_BASE = 0;
const RADIAL_K = 0.05;
const APP_ROOT_ID = 'app:host';
// Reduced-motion: run a shot of ticks then freeze. Live mode runs forever.
const RM_TICK_BUDGET = 240;

const RM_QUERY = '(prefers-reduced-motion: reduce)';

const KIND_LABEL: Record<ServiceMapNodeKind, string> = {
  endpoint: 'endpoint',
  service: 'service',
  externalHttp: 'external',
  database: 'data',
};

/**
 * Force-directed mesh of the entire call graph — Obsidian-style. Every endpoint /
 * service / external / database renders at once, with Coulomb-like repulsion
 * pushing nodes apart, springs attracting connected pairs, and a soft centre
 * gravity preventing the simulation from drifting to infinity. Drag a node to
 * pin it; wheel zooms with the cursor as pivot; drag empty canvas to pan.
 *
 * Why a custom physics loop instead of D3-force or react-force-graph?
 *  - Zero new dependencies (UI bundle stays tight).
 *  - Single rAF loop with pause-on-blur — predictable and easy to profile.
 *  - Scope is small (graphs of <150 nodes); O(N²) repulsion is comfortable.
 *
 * Positions live in refs (not React state) so we don't fire 60 re-renders per
 * second through Reconciler. A monotonic `tick` counter triggers a single
 * re-render per frame with the latest ref values; SVG transforms re-paint.
 */
export function SystemMapView({
  map,
  visibleKinds,
  search = '',
  selectedId,
  onSelect,
  width = 1000,
  height = 720,
}: Props) {
  const filtered = useMemo(() => filterMap(map, visibleKinds, search), [map, visibleKinds, search]);
  const nodeIds = useMemo(() => filtered.nodes.map((n) => n.id).join('|'), [filtered.nodes]);

  // ── Simulation state (refs — out-of-band of React render cycle) ────────
  const positionsRef = useRef<Map<string, Vec>>(new Map());
  const transformRef = useRef<Transform>({ tx: 0, ty: 0, scale: 1 });
  const dragRef = useRef<{ id: string } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null);
  const runningRef = useRef<boolean>(true);
  const tickBudgetRef = useRef<number>(Number.POSITIVE_INFINITY);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [, forceRender] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const focusId = hoverId ?? selectedId ?? null;

  // ── Initialise positions for newly-visible nodes; drop stale ones ──────
  useEffect(() => {
    const positions = positionsRef.current;
    const live = new Set(filtered.nodes.map((n) => n.id));
    for (const id of [...positions.keys()]) {
      if (!live.has(id)) positions.delete(id);
    }
    const cx = width / 2;
    const cy = height / 2;
    const maxLevel = Math.max(1, ...filtered.nodes.map((n) => Math.max(0, n.level)));
    for (const n of filtered.nodes) {
      if (n.id === APP_ROOT_ID) {
        // Pin the synthetic application root dead-centre so the rings have a
        // stable axis. Velocity stays zero through the whole simulation.
        positions.set(n.id, { x: cx, y: cy, vx: 0, vy: 0 });
        continue;
      }
      if (!positions.has(n.id)) {
        // Place each node on its tier's ring; angle is random for organic spread.
        // Unreachable nodes (level < 0) get parked on the outermost ring.
        const lvl = n.level >= 0 ? n.level : maxLevel + 1;
        const targetR = RING_BASE + lvl * RING_GAP;
        const a = Math.random() * Math.PI * 2;
        positions.set(n.id, { x: cx + Math.cos(a) * targetR, y: cy + Math.sin(a) * targetR, vx: 0, vy: 0 });
      }
    }
    // Reset reduced-motion budget so layout settles after each filter change.
    if (matchesReducedMotion()) tickBudgetRef.current = RM_TICK_BUDGET;
  }, [nodeIds, width, height]);

  // ── rAF loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    function loop() {
      if (runningRef.current && tickBudgetRef.current > 0) {
        step(filtered.nodes, filtered.edges, positionsRef.current, dragRef.current, width, height);
        if (Number.isFinite(tickBudgetRef.current)) tickBudgetRef.current -= 1;
        forceRender((n) => (n + 1) & 0xffff);
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [filtered.nodes, filtered.edges, width, height]);

  // ── Pause on tab blur, resume on focus ─────────────────────────────────
  useEffect(() => {
    function pause() { runningRef.current = false; }
    function resume() { runningRef.current = true; }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause(); else resume();
    });
    window.addEventListener('blur', pause);
    window.addEventListener('focus', resume);
    return () => {
      window.removeEventListener('blur', pause);
      window.removeEventListener('focus', resume);
    };
  }, []);

  // ── Pointer interactions: drag node, pan empty canvas ──────────────────
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (dragRef.current) {
        const w = clientToWorld(svgRef.current, transformRef.current, e.clientX, e.clientY);
        const p = positionsRef.current.get(dragRef.current.id);
        if (p) {
          p.x = w.x; p.y = w.y; p.vx = 0; p.vy = 0;
        }
        // Live mode resumes ticking so the rest of the graph re-balances.
        tickBudgetRef.current = Math.max(tickBudgetRef.current, 60);
      } else if (panRef.current) {
        const { sx, sy, tx0, ty0 } = panRef.current;
        transformRef.current = {
          ...transformRef.current,
          tx: tx0 + (e.clientX - sx),
          ty: ty0 + (e.clientY - sy),
        };
        forceRender((n) => (n + 1) & 0xffff);
      }
    }
    function onUp() {
      dragRef.current = null;
      if (panRef.current) {
        panRef.current = null;
        setIsPanning(false);
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  function startDrag(id: string, e: React.PointerEvent) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { id };
    tickBudgetRef.current = Math.max(tickBudgetRef.current, 60);
  }
  function startPan(e: React.PointerEvent) {
    if (e.button !== 0) return;
    panRef.current = {
      sx: e.clientX,
      sy: e.clientY,
      tx0: transformRef.current.tx,
      ty0: transformRef.current.ty,
    };
    setIsPanning(true);
  }
  function onBackgroundClick() {
    if (!panRef.current) onSelect(null);
  }
  function onWheel(e: React.WheelEvent) {
    // SVG wheel events are passive in React; we attach a non-passive listener
    // via ref to call preventDefault. See the wheel-binding effect below.
    // No-op here so React doesn't double-process.
    void e;
  }

  // Wheel zoom — attach non-passive listener so we can preventDefault and
  // keep the mouse pivot stable.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheelNative(ev: WheelEvent) {
      ev.preventDefault();
      const t = transformRef.current;
      const factor = Math.exp(-ev.deltaY * 0.0015);
      const newScale = clamp(t.scale * factor, 0.3, 3);
      // Zoom around the cursor: keep the world point under the mouse fixed.
      const rect = el!.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const worldX = (mx - t.tx) / t.scale;
      const worldY = (my - t.ty) / t.scale;
      transformRef.current = {
        scale: newScale,
        tx: mx - worldX * newScale,
        ty: my - worldY * newScale,
      };
      forceRender((n) => (n + 1) & 0xffff);
    }
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  // Keyboard: `0` resets transform.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '0' && (document.activeElement === document.body || document.activeElement === svgRef.current)) {
        transformRef.current = { tx: 0, ty: 0, scale: 1 };
        forceRender((n) => (n + 1) & 0xffff);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Render-time derived data ───────────────────────────────────────────
  const focusNeighborhood = useMemo(() => {
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    for (const e of filtered.edges) {
      if (e.from === focusId) set.add(e.to);
      else if (e.to === focusId) set.add(e.from);
    }
    return set;
  }, [focusId, filtered.edges]);

  const positions = positionsRef.current;
  const t = transformRef.current;

  return (
    <svg
      ref={svgRef}
      className={`sysmap-svg${isPanning ? ' is-panning' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="system map"
      onPointerDown={startPan}
      onClick={onBackgroundClick}
      onWheel={onWheel}
    >
      <defs>
        <pattern id="sysmap-bg-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill="var(--fg-3)" opacity="0.18" />
        </pattern>
      </defs>
      <rect x={0} y={0} width={width} height={height} fill="url(#sysmap-bg-dots)" />

      <g transform={`translate(${t.tx}, ${t.ty}) scale(${t.scale})`}>
        {/* Edges first so nodes paint over them. */}
        <g className="sysmap-edges">
          {filtered.edges.map((e, i) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            const dim = focusNeighborhood && !(focusNeighborhood.has(e.from) && focusNeighborhood.has(e.to));
            const calls = Math.max(1, e.callSites ?? 1);
            const strokeWidth = Math.min(3.5, 0.9 + Math.log2(calls) * 0.6);
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                opacity={dim ? 0.06 : focusId ? 0.6 : 0.22}
                className={`sysmap-edge sysmap-edge-${e.kind}`}
              />
            );
          })}
        </g>

        {/* Nodes — kind drives shape AND fill so the legend is redundant in a good way. */}
        <g className="sysmap-nodes">
          {filtered.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const isFocus = focusId === n.id;
            const inHalo = focusNeighborhood ? focusNeighborhood.has(n.id) : true;
            const isSelected = selectedId === n.id;
            const isDragging = dragRef.current?.id === n.id;
            const size = nodeRadius(n);
            return (
              <g
                key={n.id}
                className={`sysmap-node sysmap-node-${n.kind}${isSelected ? ' is-selected' : ''}${isFocus ? ' is-focus' : ''}${isDragging ? ' is-dragging' : ''}`}
                transform={`translate(${p.x}, ${p.y})`}
                opacity={inHalo ? 1 : 0.18}
                onPointerEnter={() => setHoverId(n.id)}
                onPointerLeave={() => setHoverId(null)}
                onPointerDown={(ev) => startDrag(n.id, ev)}
                onClick={(ev) => { ev.stopPropagation(); onSelect(n.id); }}
                tabIndex={0}
                role="button"
                aria-label={`${KIND_LABEL[n.kind]} ${n.label}`}
              >
                <NodeShape kind={n.kind} method={n.httpMethod} size={size} />
                <text
                  className={`sysmap-node-label${isFocus ? ' is-focus' : ''}`}
                  x={0}
                  y={size + 14}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {truncate(n.label, 26)}
                </text>
              </g>
            );
          })}
        </g>
      </g>

      {/* Floating zoom controls — pinned to viewport, not the world transform. */}
      <g className="sysmap-fab" transform={`translate(${width - 110}, ${height - 38})`}>
        <FabButton x={0}  label="−" onClick={() => zoomBy(transformRef, svgRef.current, 1 / 1.2, forceRender)} title="zoom out" />
        <FabButton x={32} label="+" onClick={() => zoomBy(transformRef, svgRef.current, 1.2, forceRender)} title="zoom in" />
        <FabButton x={64} label="⌖" onClick={() => { transformRef.current = { tx: 0, ty: 0, scale: 1 }; forceRender((n) => (n + 1) & 0xffff); }} title="recenter" />
      </g>
    </svg>
  );
}

/* ─── Mini physics ───────────────────────────────────────────────────────── */

function step(
  nodes: ServiceMapNode[],
  edges: ServiceMapEdge[],
  pos: Map<string, Vec>,
  drag: { id: string } | null,
  width: number,
  height: number,
) {
  const cx = width / 2;
  const cy = height / 2;
  const draggedId = drag?.id ?? null;
  const maxLevel = Math.max(1, ...nodes.map((n) => Math.max(0, n.level)));

  // Snapshot positions to avoid double-applying force within the same tick.
  const arr: { id: string; p: Vec; level: number }[] = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) arr.push({ id: n.id, p, level: n.level });
  }

  // 1. Repulsion (pairwise).
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i].p; const b = arr[j].p;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const d2 = Math.max(EPS, dx * dx + dy * dy);
      const inv = 1 / Math.sqrt(d2);
      const f = REPEL / d2;
      const fx = f * dx * inv;
      const fy = f * dy * inv;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }

  // 2. Springs along edges. Heavily-called pairs get shorter rest length so
  // hot dependencies cluster visually.
  for (const e of edges) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x; const dy = b.y - a.y;
    const dist = Math.max(EPS, Math.sqrt(dx * dx + dy * dy));
    const calls = Math.max(1, e.callSites ?? 1);
    const rest = REST_BASE / Math.max(1, Math.log2(calls + 2));
    const f = SPRING_K * (dist - rest);
    const fx = f * dx / dist;
    const fy = f * dy / dist;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  // 3. Radial tier bias + integrate. Each node has a target ring radius based
  // on its BFS level from the application root. The radial spring pulls the
  // node toward its ring; angular position is left to repulsion + edge springs.
  for (let i = 0; i < arr.length; i++) {
    const { id, p, level } = arr[i];
    if (id === APP_ROOT_ID) {
      // Application root pinned dead-centre; no physics.
      p.x = cx; p.y = cy; p.vx = 0; p.vy = 0;
      continue;
    }
    if (id === draggedId) {
      // Pinned by drag — physics ignored. Velocity stays zero.
      p.vx = 0; p.vy = 0;
      continue;
    }
    const lvl = level >= 0 ? level : maxLevel + 1;
    const targetR = RING_BASE + lvl * RING_GAP;
    const dx = p.x - cx; const dy = p.y - cy;
    const curR = Math.sqrt(dx * dx + dy * dy) || EPS;
    const radialF = (curR - targetR) * RADIAL_K;
    p.vx -= (dx / curR) * radialF;
    p.vy -= (dy / curR) * radialF;
    p.vx *= DAMPING;
    p.vy *= DAMPING;
    // Velocity clamp keeps a wild repulsion spike from yeeting a node off-screen.
    p.vx = clamp(p.vx, -MAX_VEL, MAX_VEL);
    p.vy = clamp(p.vy, -MAX_VEL, MAX_VEL);
    p.x += p.vx * DT;
    p.y += p.vy * DT;
  }
}

/* ─── Visual helpers ─────────────────────────────────────────────────────── */

function nodeRadius(n: ServiceMapNode): number {
  // Coupling-driven size, capped so massive hubs don't crush their neighbours.
  const base = n.kind === 'endpoint' ? 13 : n.kind === 'service' ? 12 : 11;
  const boost = Math.min(7, Math.max(0, Math.log2((n.metrics.coupling ?? 0) + 1)) * 2);
  return base + boost;
}

function NodeShape({ kind, method, size }: { kind: ServiceMapNodeKind; method?: string; size: number }) {
  switch (kind) {
    case 'endpoint': {
      const w = size * 2.4;
      const h = size * 1.05;
      return (
        <g>
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} className="sysmap-shape" />
          {method && (
            <text className="sysmap-method" x={0} y={1} textAnchor="middle" dominantBaseline="middle">
              {method.toUpperCase().slice(0, 4)}
            </text>
          )}
        </g>
      );
    }
    case 'service':
      return <circle r={size} className="sysmap-shape" />;
    case 'externalHttp': {
      const s = size * 1.05;
      return <rect x={-s} y={-s} width={s * 2} height={s * 2} className="sysmap-shape" transform="rotate(45)" />;
    }
    case 'database': {
      const rx = size * 1.1;
      const ry = size * 0.78;
      return (
        <g>
          <ellipse cx={0} cy={0} rx={rx} ry={ry} className="sysmap-shape" />
          <line x1={-rx * 0.8} y1={-ry * 0.4} x2={rx * 0.8} y2={-ry * 0.4} className="sysmap-shape-stripe" />
          <line x1={-rx * 0.8} y1={ry * 0.4}  x2={rx * 0.8} y2={ry * 0.4}  className="sysmap-shape-stripe" />
        </g>
      );
    }
  }
}

function FabButton({ x, label, onClick, title }: { x: number; label: string; onClick: () => void; title: string }) {
  return (
    <g
      className="sysmap-fab-btn"
      transform={`translate(${x}, 0)`}
      onPointerDown={(e) => { e.stopPropagation(); }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      role="button"
      aria-label={title}
    >
      <title>{title}</title>
      <rect x={0} y={0} width={28} height={28} rx={6} className="sysmap-fab-bg" />
      <text x={14} y={15} textAnchor="middle" dominantBaseline="middle" className="sysmap-fab-text">{label}</text>
    </g>
  );
}

/* ─── Filtering & utils ──────────────────────────────────────────────────── */

function filterMap(map: ServiceMap, kinds: ReadonlySet<ServiceMapNodeKind>, search: string) {
  const q = search.trim().toLowerCase();
  const allow = (n: ServiceMapNode) => {
    if (n.isIsolated) return false;
    if (!kinds.has(n.kind)) return false;
    if (!q) return true;
    const blob = `${n.label} ${n.fullName ?? ''} ${n.resolvedImplType ?? ''}`.toLowerCase();
    return blob.includes(q);
  };
  const nodes = map.nodes.filter(allow);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = map.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

function clientToWorld(
  svg: SVGSVGElement | null,
  t: Transform,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (!svg) return { x: 0, y: 0 };
  const rect = svg.getBoundingClientRect();
  // viewBox runs 0..width × 0..height, fitted into rect with preserveAspectRatio
  // xMidYMid meet. Approximate: assume fitted on the larger axis.
  const vw = svg.viewBox.baseVal.width || rect.width;
  const vh = svg.viewBox.baseVal.height || rect.height;
  const sx = rect.width / vw;
  const sy = rect.height / vh;
  const fit = Math.min(sx, sy);
  const offX = (rect.width - vw * fit) / 2;
  const offY = (rect.height - vh * fit) / 2;
  const localX = (clientX - rect.left - offX) / fit;
  const localY = (clientY - rect.top - offY) / fit;
  // Reverse the world transform.
  return { x: (localX - t.tx) / t.scale, y: (localY - t.ty) / t.scale };
}

function zoomBy(
  ref: React.MutableRefObject<Transform>,
  svg: SVGSVGElement | null,
  factor: number,
  forceRender: React.Dispatch<React.SetStateAction<number>>,
) {
  const t = ref.current;
  const newScale = clamp(t.scale * factor, 0.3, 3);
  if (svg) {
    // Pivot on viewport centre.
    const rect = svg.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const worldX = (mx - t.tx) / t.scale;
    const worldY = (my - t.ty) / t.scale;
    ref.current = {
      scale: newScale,
      tx: mx - worldX * newScale,
      ty: my - worldY * newScale,
    };
  } else {
    ref.current = { ...t, scale: newScale };
  }
  forceRender((n) => (n + 1) & 0xffff);
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function matchesReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(RM_QUERY).matches;
}

export type { ServiceMap, ServiceMapEdge, ServiceMapNode };
