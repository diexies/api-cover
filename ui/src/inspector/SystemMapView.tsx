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
// Reduced-motion: run a shot of ticks then freeze. Normal mode also caps at a
// settle budget for graphs >= LARGE_GRAPH_N; below that, runs to natural sleep.
const RM_TICK_BUDGET = 240;
// O(N²) repulsion makes large graphs cost-prohibitive past ~150 nodes (60fps drops
// to single digits with 200+). Above this threshold we hard-cap tick count and
// rely on auto-freeze (KE < threshold) to stop spinning the CPU.
const LARGE_GRAPH_N = 150;
const LARGE_GRAPH_TICK_BUDGET = 320;
// Kinetic-energy threshold for auto-freeze. Below this, layout is "settled"
// and we stop ticking until the user interacts.
const SETTLE_KE_PER_NODE = 0.05;
// LOD: below this zoom, per-node labels are unreadable anyway — skip their DOM
// entirely. Labels are the single largest chunk of SVG elements on big maps.
const LABEL_MIN_SCALE = 0.65;
// Viewport-culling margin (world px) so nodes don't visibly pop at the edge mid-pan.
const CULL_MARGIN = 100;
// Spatial-hash cell for repulsion. At REPEL=8000 the pair force one cell away
// (~170 px) is under 0.3 px/tick — below visual noise — so truncating repulsion
// to neighbouring cells keeps the settled layout while dropping O(N²) to ~O(N).
const GRID_CELL = 170;

const RM_QUERY = '(prefers-reduced-motion: reduce)';

const KIND_LABEL: Record<ServiceMapNodeKind, string> = {
  endpoint: 'endpoint',
  service: 'service',
  externalHttp: 'external',
  database: 'data',
};

/**
 * Force-directed mesh of the call graph — Obsidian-style. Coulomb-like repulsion
 * pushes nodes apart, springs attract connected pairs, and a radial tier bias
 * pulls each node to its BFS ring. Drag a node to pin it; wheel zooms with the
 * cursor as pivot; drag empty canvas to pan.
 *
 * Large-graph strategy (>= LARGE_GRAPH_N nodes): ring-depth LOD opens the map at
 * the deepest ring that fits the budget (▽/△ FAB widens it), labels drop below
 * LABEL_MIN_SCALE zoom, off-viewport nodes/edges emit no DOM, repulsion runs on
 * a spatial hash, and paints happen every 2nd frame while unsettled.
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
  const base = useMemo(() => filterBase(map, visibleKinds, search), [map, visibleKinds, search]);
  // Ring-depth LOD ("heights"): large graphs open at the deepest ring that stays
  // within the physics/DOM comfort budget; the user widens from there via the FAB.
  const autoDepth = useMemo(() => {
    if (base.nodes.length <= LARGE_GRAPH_N) return Number.POSITIVE_INFINITY;
    const perRing = new Map<number, number>();
    for (const n of base.nodes) {
      const l = effLevel(n, base.maxLevel);
      perRing.set(l, (perRing.get(l) ?? 0) + 1);
    }
    let cum = 0;
    let depth = 1;
    for (let l = 0; l <= base.maxLevel + 1; l++) {
      cum += perRing.get(l) ?? 0;
      if (cum > LARGE_GRAPH_N && l > 0) break;
      depth = l;
    }
    return Math.max(1, depth);
  }, [base]);
  const [depthOverride, setDepthOverride] = useState<number | null>(null);
  const maxDepth = base.maxLevel + 1;
  const effectiveDepth = Math.min(depthOverride ?? autoDepth, maxDepth);
  const filtered = useMemo(() => applyDepth(base, effectiveDepth), [base, effectiveDepth]);
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
    // Reset tick budget so layout settles after each filter change. Reduced-motion users get
    // the smaller budget. Large graphs (>=LARGE_GRAPH_N) get a cap regardless of preference
    // because O(N²) repulsion is what causes the laggy/flickery render the user sees with
    // 200+ nodes (e.g. PVC's 243-endpoint discovery surface).
    if (matchesReducedMotion()) {
      tickBudgetRef.current = RM_TICK_BUDGET;
    } else if (filtered.nodes.length >= LARGE_GRAPH_N) {
      tickBudgetRef.current = LARGE_GRAPH_TICK_BUDGET;
    } else {
      tickBudgetRef.current = Number.POSITIVE_INFINITY;
    }
  }, [nodeIds, width, height, filtered.nodes.length]);

  // ── rAF loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    // Counter so settled state can still re-render on interaction without
    // burning frames in idle. When ke per node falls below SETTLE_KE_PER_NODE
    // we stop both stepping and re-rendering until a drag/pan/wheel wakes us.
    let consecutiveSettled = 0;
    let frame = 0;
    function loop() {
      if (runningRef.current && tickBudgetRef.current > 0) {
        const ke = step(filtered.nodes, filtered.edges, positionsRef.current, dragRef.current, width, height);
        if (Number.isFinite(tickBudgetRef.current)) tickBudgetRef.current -= 1;
        const kePerNode = filtered.nodes.length > 0 ? ke / filtered.nodes.length : 0;
        if (kePerNode < SETTLE_KE_PER_NODE && !dragRef.current && !panRef.current) {
          consecutiveSettled++;
          if (consecutiveSettled > 30) {
            tickBudgetRef.current = 0; // freeze
          }
        } else {
          consecutiveSettled = 0;
        }
        // Large graphs paint every 2nd frame — physics still steps every frame so
        // settling speed is unchanged, but reconciler cost halves while unsettled.
        frame++;
        if (filtered.nodes.length < LARGE_GRAPH_N || (frame & 1) === 0 || tickBudgetRef.current <= 0) {
          forceRender((n) => (n + 1) & 0xffff);
        }
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
        if (tickBudgetRef.current <= 0) tickBudgetRef.current = 1;
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
      // Wheel zoom alone does not need physics ticks (pan-only repaint), but it
      // also should not get stuck if the layout has frozen — wake the loop just
      // long enough for the next paint frame.
      if (tickBudgetRef.current <= 0) tickBudgetRef.current = 1;
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

  // LOD + viewport culling. Labels vanish below readable zoom (except the focused/
  // selected node); nodes and edges fully outside the visible world rect emit no DOM.
  const showLabels = t.scale >= LABEL_MIN_SCALE;
  const cullL = (0 - t.tx) / t.scale - CULL_MARGIN;
  const cullT = (0 - t.ty) / t.scale - CULL_MARGIN;
  const cullR = (width - t.tx) / t.scale + CULL_MARGIN;
  const cullB = (height - t.ty) / t.scale + CULL_MARGIN;

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
            if (Math.max(a.x, b.x) < cullL || Math.min(a.x, b.x) > cullR ||
                Math.max(a.y, b.y) < cullT || Math.min(a.y, b.y) > cullB) return null;
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
            if (p.x < cullL || p.x > cullR || p.y < cullT || p.y > cullB) return null;
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
                {(showLabels || isFocus || isSelected) && (
                  <text
                    className={`sysmap-node-label${isFocus ? ' is-focus' : ''}`}
                    x={0}
                    y={size + 14}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {truncate(n.label, 26)}
                  </text>
                )}
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

      {/* Ring-depth controls — how many BFS rings ("heights") are rendered. */}
      {maxDepth > 1 && (
        <g className="sysmap-fab" transform={`translate(${width - 110}, ${height - 74})`}>
          <FabButton x={0}  label="▽" onClick={() => setDepthOverride(Math.max(1, effectiveDepth - 1))} title="fewer rings" />
          <FabButton x={32} label="△" onClick={() => setDepthOverride(Math.min(maxDepth, effectiveDepth + 1))} title="more rings" />
          <text x={78} y={15} textAnchor="middle" dominantBaseline="middle" className="sysmap-fab-text">
            {`${effectiveDepth}/${maxDepth}`}
          </text>
        </g>
      )}

      {filtered.nodes.length < base.nodes.length && (
        <text x={12} y={height - 12} className="sysmap-node-label" opacity={0.75}>
          {`${filtered.nodes.length}/${base.nodes.length} nodes · ring depth ${effectiveDepth}/${maxDepth}`}
        </text>
      )}
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
): number {
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

  // 1. Repulsion — spatial hash: only pairs within neighbouring cells interact.
  // Force one cell away (~GRID_CELL px) is below visual noise at REPEL=8000, so
  // truncation keeps the settled layout while dropping O(N²) to roughly O(N).
  const grid = new Map<number, number[]>();
  for (let i = 0; i < arr.length; i++) {
    const key = cellKey(arr[i].p.x, arr[i].p.y);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i); else grid.set(key, [i]);
  }
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i].p;
    const cx0 = Math.floor(a.x / GRID_CELL);
    const cy0 = Math.floor(a.y / GRID_CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(packCell(cx0 + ox, cy0 + oy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = arr[j].p;
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
  let kineticEnergy = 0;
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
    kineticEnergy += p.vx * p.vx + p.vy * p.vy;
  }
  return kineticEnergy;
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

interface BaseGraph {
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
  maxLevel: number;
}

function filterBase(map: ServiceMap, kinds: ReadonlySet<ServiceMapNodeKind>, search: string): BaseGraph {
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
  const maxLevel = Math.max(0, ...nodes.map((n) => Math.max(0, n.level)));
  return { nodes, edges, maxLevel };
}

// Ring-depth LOD: keep only nodes whose BFS ring sits within `depth`. Unreachable
// nodes (level < 0) live one past the outermost ring, so they are the first thing
// a tighter depth folds away.
function applyDepth(base: BaseGraph, depth: number) {
  if (!Number.isFinite(depth)) return { nodes: base.nodes, edges: base.edges };
  const nodes = base.nodes.filter((n) => effLevel(n, base.maxLevel) <= depth);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = base.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

function effLevel(n: ServiceMapNode, maxLevel: number): number {
  return n.level >= 0 ? n.level : maxLevel + 1;
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

// Packed cell coordinates for the repulsion spatial hash. Collision-free while
// |cellY| < 50000 (world y < ~8.5M px — far beyond any layout).
function packCell(cx: number, cy: number): number {
  return cx * 100000 + cy;
}

function cellKey(x: number, y: number): number {
  return packCell(Math.floor(x / GRID_CELL), Math.floor(y / GRID_CELL));
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
