import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ApiNodeView, type ApiNodeData } from './ApiNodeView';
import { GroupAreaNode, type GroupAreaData } from './GroupAreaNode';
import { CaseAreaNode, type CaseAreaData } from './CaseAreaNode';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ENDPOINT_DRAG_MIME } from './EndpointPalette';
import { NodeInspector } from './NodeInspector';
import { authToRunOptions, type AuthConfig } from './auth';
import { GroupSettingsModal } from './GroupSettingsModal';
import { autoLayout } from './layout';
import { wouldCreateCycle } from './dag';
import { normalisePath } from './App';
import { useResizableWidth } from './useResizableWidth';
import { FlowHeader } from './FlowHeader';
import { BranchDiagram } from './inspector/BranchDiagram';
import { QuickCallPanel } from './QuickCallPanel';
import {
  aggregateNodeResult,
  branchKey,
  getNodeResult,
  getRun,
  saveScenario,
  startRun,
  subscribeRunEvents,
  type ApiNode,
  type Breakpoint,
  type CaseSet,
  type EndpointDescriptor,
  type ExecutionGroup,
  type NodeResult,
  type NodeStatus,
  type Run,
  type RunEvent,
  type Scenario,
} from './api';

const nodeTypes = { api: ApiNodeView, groupArea: GroupAreaNode, caseArea: CaseAreaNode };

const GROUP_PALETTE = ['#a855f7', '#06b6d4', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];

const NEW_NODE_W = 220;
const NEW_NODE_H = 80;

function colorForGroup(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GROUP_PALETTE[Math.abs(h) % GROUP_PALETTE.length];
}

type EndpointStatBucket = {
  passed: number;
  failed: number;
  perScenario: Map<string, { passed: number; failed: number }>;
};

interface Props {
  scenario: Scenario;
  endpointLookup: Map<string, EndpointDescriptor>;
  scenariosUsingEndpoint?: Map<string, { id: string; name: string }[]>;
  endpointStatsByKey?: Map<string, EndpointStatBucket>;
  auth: AuthConfig;
  enableCallGraph?: boolean;
  onSaved: (scenario: Scenario) => void;
}

export function ScenarioCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <ScenarioCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ScenarioCanvasInner({ scenario, endpointLookup, scenariosUsingEndpoint, endpointStatsByKey, auth, enableCallGraph, onSaved }: Props) {
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const unsubRef = useRef<(() => void) | null>(null);
  const onSaveRef = useRef<() => Promise<void>>(async () => {});
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // Authoritative scenario state (full ApiNode data) — RF state is just the visual mirror.
  const [apiNodes, setApiNodes] = useState<ApiNode[]>(scenario.nodes);
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>(scenario.breakpoints ?? []);
  const [startNodeIds, setStartNodeIds] = useState<string[]>(scenario.startNodeIds ?? []);
  const [groups, setGroups] = useState<ExecutionGroup[]>(scenario.groups ?? []);
  const [caseSets, setCaseSets] = useState<CaseSet[]>(scenario.caseSets ?? []);
  // Editable scenario meta (business flow framing).
  const [flowName, setFlowName] = useState<string>(scenario.name);
  const [flowDescription, setFlowDescription] = useState<string>(scenario.description ?? '');
  const [flowTags, setFlowTags] = useState<string[]>(scenario.tags ?? []);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // null = aggregate ("all branches"); otherwise a branchKey from the current run.
  const [selectedBranchKey, setSelectedBranchKey] = useState<string | null>(null);
  const [quickCallEp, setQuickCallEp] = useState<EndpointDescriptor | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  type Menu = { x: number; y: number; items: MenuItem[] } | null;
  const [menu, setMenu] = useState<Menu>(null);

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Suppress Shift only when focus is inside a text-entry control, so RF's global selection
  // listener stays armed for everywhere else (canvas drag, body click, etc.).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      const isText = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
      if (isText) e.stopPropagation();
    };
    document.addEventListener('keydown', handler, true);
    document.addEventListener('keyup', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('keyup', handler, true);
    };
  }, []);

  const initial = useMemo(() => buildFromScenario(scenario), [scenario.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(initial.edges);

  // Reset everything when scenario changes. Force-saves any pending edits to the
  // outgoing scenario before swapping so a debounce in flight doesn't lose data.
  useEffect(() => {
    if (dirtyRef.current) void onSaveRef.current();
    const fresh = buildFromScenario(scenario);
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setApiNodes(scenario.nodes);
    setBreakpoints(scenario.breakpoints ?? []);
    setStartNodeIds(scenario.startNodeIds ?? []);
    setGroups(scenario.groups ?? []);
    setCaseSets(scenario.caseSets ?? []);
    setFlowName(scenario.name);
    setFlowDescription(scenario.description ?? '');
    setFlowTags(scenario.tags ?? []);
    setRun(null);
    setErr(null);
    setRunning(false);
    setDirty(false);
    setLastSavedAt(null);
    setSelectedNodeId(null);
    setSelectedBranchKey(null);
    unsubRef.current?.();
    unsubRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id]);

  useEffect(() => () => { unsubRef.current?.(); unsubRef.current = null; }, []);

  // Guard against accidental tab close / reload while edits are pending the
  // 800ms debounce or while a save is in flight. Browsers ignore custom text
  // and show their own "Leave site?" prompt — non-empty returnValue is enough
  // to trigger it. No-op when the canvas is clean.
  useEffect(() => {
    if (!dirty && !saving) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, saving]);

  // Live geometric membership: recompute every group's nodeIds from current positions vs
  // current bounds. Node moved out of a rectangle → no longer a member. Node moved in → now
  // a member. Runs whenever positions or group bounds change. Drops groups whose RF area
  // node was deleted from the canvas.
  useEffect(() => {
    const apiRf = nodes.filter(isApiRf);
    const groupRf = nodes.filter(isGroupRfNode);

    setGroups((cur) => {
      let changed = false;
      const next = cur
        .filter((g) => groupRf.some((n) => groupIdFromRf(n.id) === g.id) || !g.bounds)
        .map((g) => {
          const rf = groupRf.find((n) => groupIdFromRf(n.id) === g.id);
          if (!rf) return g;
          const bounds = {
            x: rf.position.x,
            y: rf.position.y,
            width: (rf.style?.width as number | undefined) ?? rf.measured?.width ?? g.bounds?.width ?? 200,
            height: (rf.style?.height as number | undefined) ?? rf.measured?.height ?? g.bounds?.height ?? 120,
          };
          const memberIds = apiRf
            .filter((n) => {
              const w = n.measured?.width ?? NEW_NODE_W;
              const h = n.measured?.height ?? NEW_NODE_H;
              const cx = n.position.x + w / 2;
              const cy = n.position.y + h / 2;
              const inside = cx >= bounds.x && cx <= bounds.x + bounds.width
                  && cy >= bounds.y && cy <= bounds.y + bounds.height;
              // eslint-disable-next-line no-console
              console.debug('[membership]', g.id, 'check', n.id, { cx, cy, bounds, w, h, measured: n.measured, inside });
              return inside;
            })
            .map((n) => n.id);

          const sameBounds = g.bounds
            && g.bounds.x === bounds.x && g.bounds.y === bounds.y
            && g.bounds.width === bounds.width && g.bounds.height === bounds.height;
          // Order-insensitive set equality: RF can reshuffle filter results between renders;
          // an order-only diff would churn groups state and visually drop the ring for a frame.
          const prevSet = new Set(g.nodeIds);
          const sameMembers = g.nodeIds.length === memberIds.length
            && memberIds.every((id) => prevSet.has(id));
          if (sameBounds && sameMembers) return g;
          changed = true;
          return { ...g, bounds, nodeIds: memberIds };
        });
      if (next.length !== cur.length) changed = true;
      return changed ? next : cur;
    });
  }, [nodes]);

  // Case-set area rectangles. Derived: for each CaseSet, bounding box of (anchor + downstream
  // reachable nodes) padded by PAD. Re-emitted whenever caseSets, edges, or node positions
  // change. Idempotent — returns the prior state reference when nothing changed so React
  // skips a re-render and the effect doesn't re-fire.
  useEffect(() => {
    setNodes((cur) => {
      const apiRf = cur.filter(isApiRf);
      const PAD = 28;
      type Desired = { id: string; pos: { x: number; y: number }; w: number; h: number; data: CaseAreaData };
      const desired: Desired[] = [];
      for (const cs of caseSets) {
        if (!cs.variants || cs.variants.length === 0) continue;
        const reach = collectDescendants(cs.anchorNodeId, edges as RFEdge[]);
        const members = apiRf.filter((n) => reach.has(n.id));
        if (members.length === 0) continue;
        const minX = Math.min(...members.map((n) => n.position.x)) - PAD;
        const minY = Math.min(...members.map((n) => n.position.y)) - PAD - 14; // extra room for label
        const maxX = Math.max(...members.map((n) => n.position.x + (n.measured?.width ?? NEW_NODE_W))) + PAD;
        const maxY = Math.max(...members.map((n) => n.position.y + (n.measured?.height ?? NEW_NODE_H))) + PAD;
        desired.push({
          id: cs.id,
          pos: { x: minX, y: minY },
          w: maxX - minX,
          h: maxY - minY,
          data: {
            label: cs.label ?? cs.anchorNodeId,
            color: cs.backgroundColor ?? '#a855f7',
            variantCount: cs.variants.length,
          },
        });
      }
      const existing = cur.filter(isCaseRfNode);
      let changed = existing.length !== desired.length;
      if (!changed) {
        for (const d of desired) {
          const found = existing.find((n) => caseIdFromRf(n.id) === d.id);
          if (!found) { changed = true; break; }
          if (found.position.x !== d.pos.x || found.position.y !== d.pos.y) { changed = true; break; }
          if ((found.style?.width as number | undefined) !== d.w) { changed = true; break; }
          if ((found.style?.height as number | undefined) !== d.h) { changed = true; break; }
          const fdata = found.data as CaseAreaData;
          if (fdata.label !== d.data.label || fdata.color !== d.data.color || fdata.variantCount !== d.data.variantCount) {
            changed = true; break;
          }
        }
      }
      if (!changed) return cur;
      const others = cur.filter((n) => !isCaseRfNode(n));
      const desiredRf: RFNode[] = desired.map((d) => ({
        id: caseRfId(d.id),
        type: 'caseArea',
        position: d.pos,
        style: { width: d.w, height: d.h, zIndex: -2 },
        data: d.data,
        draggable: false,
        selectable: false,
      }));
      // Case areas go first so they render BEHIND group areas + nodes (lowest in DOM = lowest z).
      return [...desiredRf, ...others];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSets, edges, nodes]);

  // Branch keys present in the current run (excluding root). Drives the picker.
  const branchKeys = useMemo(() => {
    if (!run) return [] as string[];
    const set = new Set<string>();
    for (const r of run.nodeResults) {
      const k = branchKey(r);
      if (k.length > 0) set.add(k);
    }
    return [...set].sort();
  }, [run]);

  // Drop selectedBranchKey if it disappears (e.g. run cleared or replaced).
  useEffect(() => {
    if (selectedBranchKey != null && !branchKeys.includes(selectedBranchKey)) {
      setSelectedBranchKey(null);
    }
  }, [branchKeys, selectedBranchKey]);

  // Per-group iteration progress derived from run.nodeResults whose branchPath segments
  // match `<groupId>#<n>`. Drives the live counter + pulse on the group-area node.
  // Idempotent: only writes back into the RF node `data` when the values change.
  useEffect(() => {
    type Tally = { runningIter: number; totalIter: number; passed: number; failed: number; isRunning: boolean };
    const byGroup = new Map<string, Tally>();
    for (const g of groups) {
      const total = Math.max(1, g.repeat?.count ?? 1);
      byGroup.set(g.id, { runningIter: 0, totalIter: total, passed: 0, failed: 0, isRunning: false });
    }
    if (run) {
      for (const r of run.nodeResults) {
        for (const seg of r.branchPath ?? []) {
          const m = /^(.+)#(\d+)$/.exec(seg);
          if (!m) continue;
          const tally = byGroup.get(m[1]);
          if (!tally) continue;
          const idx = parseInt(m[2], 10);
          if (idx > tally.runningIter) tally.runningIter = idx;
          if (r.status === 'succeeded') tally.passed++;
          else if (r.status === 'failed') tally.failed++;
          if (r.status === 'running' || r.status === 'paused') tally.isRunning = true;
        }
      }
    }
    setNodes((cur) => {
      let changed = false;
      const next = cur.map((n) => {
        if (!isGroupRfNode(n)) return n;
        const gid = groupIdFromRf(n.id);
        const tally = byGroup.get(gid);
        if (!tally) return n;
        const data = n.data as GroupAreaData;
        const desired: Partial<GroupAreaData> = {
          runningIter: tally.runningIter,
          totalIter: tally.totalIter,
          iterPassed: tally.passed,
          iterFailed: tally.failed,
          isRunning: tally.isRunning,
        };
        if (data.runningIter === desired.runningIter
          && data.totalIter === desired.totalIter
          && data.iterPassed === desired.iterPassed
          && data.iterFailed === desired.iterFailed
          && data.isRunning === desired.isRunning) return n;
        changed = true;
        return { ...n, data: { ...data, ...desired } };
      });
      return changed ? next : cur;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, groups]);

  // Branch fan-out: spawn synthetic RF nodes for each (in-group node × branch) so the
  // playground literally shows each iteration as its own copy of the API. Originals are
  // hidden while branches exist; cleared back when run is reset. Edges are re-routed:
  // upstream → each branch's first node, branch lanes run sequential, last → downstream.
  useEffect(() => {
    // Map nodeId → first group it belongs to (for adjacency classification).
    const inGroupOf = new Map<string, ExecutionGroup>();
    for (const g of groups) {
      for (const nid of g.nodeIds) {
        if (!inGroupOf.has(nid)) inGroupOf.set(nid, g);
      }
    }
    // groupId → ordered branchKeys observed in run
    const branchesByGroup = new Map<string, string[]>();
    if (run) {
      for (const r of run.nodeResults) {
        const fullKey = branchKey(r);
        if (fullKey === '') continue;
        for (const seg of r.branchPath ?? []) {
          const m = /^(.+)#(\d+)$/.exec(seg);
          if (!m) continue;
          const arr = branchesByGroup.get(m[1]) ?? [];
          if (!arr.includes(fullKey)) arr.push(fullKey);
          branchesByGroup.set(m[1], arr);
        }
      }
      for (const [, arr] of branchesByGroup) arr.sort();
    }
    const inBranchOriginals = new Set<string>();
    for (const [gid] of branchesByGroup) {
      const grp = groups.find((g) => g.id === gid);
      if (grp) for (const nid of grp.nodeIds) inBranchOriginals.add(nid);
    }

    setNodes((cur) => {
      const apiRf = cur.filter(isApiRf);
      const desiredClones: RFNode[] = [];
      for (const [gid, branches] of branchesByGroup) {
        const grp = groups.find((g) => g.id === gid);
        if (!grp) continue;
        const N = branches.length;
        for (const nid of grp.nodeIds) {
          const orig = apiRf.find((n) => n.id === nid);
          if (!orig) continue;
          for (let i = 0; i < N; i++) {
            const k = branches[i];
            const offset = (i - (N - 1) / 2) * BRANCH_LANE_SPREAD;
            // Resolve a friendly per-iteration label (e.g. "g_alpha ×2") inline so we don't
            // depend on branchLabelFor's hook scope here.
            const segs = k.split('/');
            const niceSegs: string[] = [];
            for (const seg of segs) {
              const rm = /^(.+)#(\d+)$/.exec(seg);
              if (rm) {
                const grpForSeg = groups.find((g) => g.id === rm[1]);
                niceSegs.push(`${grpForSeg?.label ?? rm[1]} ×${rm[2]}`);
              } else {
                niceSegs.push(seg);
              }
            }
            desiredClones.push({
              id: branchCloneRfId(nid, k),
              type: 'api',
              position: { x: orig.position.x + offset, y: orig.position.y },
              data: { ...orig.data, branchLabel: niceSegs.join(' › ') },
              draggable: false,
              selectable: true,
            });
          }
        }
      }
      // Idempotent: bail if nothing changed (clones equal + hidden flags equal).
      const existingClones = cur.filter(isBranchCloneRf);
      let cloneSetChanged = existingClones.length !== desiredClones.length;
      if (!cloneSetChanged) {
        for (const d of desiredClones) {
          const found = existingClones.find((n) => n.id === d.id);
          if (!found) { cloneSetChanged = true; break; }
          if (found.position.x !== d.position.x || found.position.y !== d.position.y) {
            cloneSetChanged = true; break;
          }
        }
      }
      let hiddenChanged = false;
      for (const n of cur) {
        if (!isApiRf(n)) continue;
        const shouldHide = inBranchOriginals.has(n.id);
        if (!!n.hidden !== shouldHide) { hiddenChanged = true; break; }
      }
      if (!cloneSetChanged && !hiddenChanged) return cur;
      const others = cur.filter((n) => !isBranchCloneRf(n));
      const updatedOthers = others.map((n) => {
        if (!isApiRf(n)) return n;
        const shouldHide = inBranchOriginals.has(n.id);
        if (!!n.hidden === shouldHide) return n;
        return { ...n, hidden: shouldHide };
      });
      return [...updatedOthers, ...desiredClones];
    });

    setEdges((cur) => {
      const origEdges = cur.filter((e) => !isBranchCloneEdge(e));
      const desiredCloneEdges: RFEdge[] = [];
      for (const e of origEdges) {
        const uIn = inBranchOriginals.has(e.source);
        const vIn = inBranchOriginals.has(e.target);
        if (!uIn && !vIn) continue;
        const gOfU = inGroupOf.get(e.source);
        const gOfV = inGroupOf.get(e.target);
        let keys: string[] = [];
        if (uIn && vIn && gOfU && gOfV && gOfU.id === gOfV.id) {
          keys = branchesByGroup.get(gOfU.id) ?? [];
        } else if (uIn && !vIn && gOfU) {
          keys = branchesByGroup.get(gOfU.id) ?? [];
        } else if (!uIn && vIn && gOfV) {
          keys = branchesByGroup.get(gOfV.id) ?? [];
        } else {
          continue; // cross-group adjacency — skip in v1
        }
        for (const k of keys) {
          const sourceId = uIn ? branchCloneRfId(e.source, k) : e.source;
          const targetId = vIn ? branchCloneRfId(e.target, k) : e.target;
          desiredCloneEdges.push({
            id: branchCloneEdgeId(e.id, k),
            source: sourceId,
            target: targetId,
          });
        }
      }
      const updatedOrigs = origEdges.map((e) => {
        const uIn = inBranchOriginals.has(e.source);
        const vIn = inBranchOriginals.has(e.target);
        const shouldHide = uIn || vIn;
        if (!!e.hidden === shouldHide) return e;
        return { ...e, hidden: shouldHide };
      });
      const existingClones = cur.filter(isBranchCloneEdge);
      let cloneSetChanged = existingClones.length !== desiredCloneEdges.length;
      if (!cloneSetChanged) {
        for (const d of desiredCloneEdges) {
          const found = existingClones.find((e) =>
            e.id === d.id && e.source === d.source && e.target === d.target);
          if (!found) { cloneSetChanged = true; break; }
        }
      }
      let hiddenChanged = false;
      for (let i = 0; i < origEdges.length; i++) {
        if (!!origEdges[i].hidden !== !!updatedOrigs[i].hidden) { hiddenChanged = true; break; }
      }
      if (!cloneSetChanged && !hiddenChanged) return cur;
      return [...updatedOrigs, ...desiredCloneEdges];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, groups, apiNodes]);

  // Pretty label for a branchKey. Recognises three segment shapes:
  //   1. `<groupId>#<n>` — repeat-iteration token emitted by the engine fan-out
  //   2. CaseVariant id → looked up in `caseSets`
  //   3. Anything else → printed as-is
  const branchLabelFor = useCallback((key: string): string => {
    const segs = key.split('/');
    const labels: string[] = [];
    for (const seg of segs) {
      const repeatMatch = /^(.+)#(\d+)$/.exec(seg);
      if (repeatMatch) {
        const grp = groups.find((g) => g.id === repeatMatch[1]);
        const grpLabel = grp?.label ?? repeatMatch[1];
        labels.push(`${grpLabel} ×${repeatMatch[2]}`);
        continue;
      }
      const found = caseSets
        .flatMap((c) => c.variants.map((v) => ({ cs: c, v })))
        .find(({ v }) => v.id === seg);
      labels.push(found ? found.v.label : seg);
    }
    return labels.join(' › ');
  }, [caseSets, groups]);

  // Overlay live status + breakpoint flag onto RF nodes / edges. Also tag each node with
  // the group it belongs to (if any) so we can render a coloured ring around it.
  useEffect(() => {
    const idle = run === null;
    const bpSet = new Set(breakpoints.filter((b) => b.enabled !== false).map((b) => b.nodeId));
    const nodeToGroup = new Map<string, string>();
    const nodeGroupAll = new Map<string, ExecutionGroup[]>();
    for (const g of groups) {
      for (const nid of g.nodeIds) {
        nodeToGroup.set(nid, g.id);
        if (!nodeGroupAll.has(nid)) nodeGroupAll.set(nid, []);
        nodeGroupAll.get(nid)!.push(g);
      }
    }
    const caseAnchorOf = new Map<string, CaseSet>();
    for (const cs of caseSets) {
      if (cs.variants && cs.variants.length > 0) caseAnchorOf.set(cs.anchorNodeId, cs);
    }
    // Branch-filtered status resolver. Three shapes feed in:
    //   1. Branch-clone RF id (`<nodeId>@@<branchKey>`) → look up that exact branch record.
    //   2. Real api node id, no chip selected → aggregate across all branches (idle/glance view).
    //   3. Real api node id, chip selected → prefer that branch's record, else root, else dim.
    function resolveResult(rfNodeId: string): { result: NodeResult | undefined; offBranch: boolean } {
      const cloned = parseBranchCloneRf(rfNodeId);
      if (cloned) {
        const result = getNodeResult(run, cloned.nodeId, cloned.branchKey);
        const off = selectedBranchKey != null && selectedBranchKey !== cloned.branchKey;
        return { result, offBranch: off };
      }
      if (selectedBranchKey == null) {
        return { result: aggregateNodeResult(run, rfNodeId), offBranch: false };
      }
      const onBranch = getNodeResult(run, rfNodeId, selectedBranchKey);
      if (onBranch) return { result: onBranch, offBranch: false };
      const onRoot = getNodeResult(run, rfNodeId, '');
      if (onRoot) return { result: onRoot, offBranch: false };
      return { result: undefined, offBranch: run !== null };
    }

    setNodes((current) =>
      current.map((n) => {
        if (isStructuralRf(n)) return n; // group / case areas don't carry status
        const cloned = parseBranchCloneRf(n.id);
        const lookupId = cloned ? cloned.nodeId : n.id;
        const { result, offBranch } = resolveResult(n.id);
        const status: NodeStatus = result?.status ?? 'pending';
        const gid = nodeToGroup.get(lookupId);
        const myGroups = nodeGroupAll.get(lookupId) ?? [];
        const cartesian = myGroups.length === 0 ? 1 : myGroups.reduce((a, g) => a * Math.max(1, g.repeat?.count ?? 1), 1);
        const anchor = caseAnchorOf.get(lookupId);
        // Clones already live inside a fan-out lane; the group "ring" wrapper would re-tint them
        // and overlap visually, so suppress it for clones (the original gets the ring instead).
        const groupCls = !cloned && gid
          ? `node-in-group group-${groupHashClass(gid)}${myGroups.length > 1 ? ' node-overlapped' : ''}`
          : '';
        const dimCls = offBranch ? 'node-off-branch' : '';
        const cloneCls = cloned ? 'node-branch-clone' : '';
        const className = [groupCls, dimCls, cloneCls].filter(Boolean).join(' ') || undefined;
        return {
          ...n,
          className,
          data: {
            ...n.data,
            status,
            response: result?.response?.body,
            error: result?.error,
            idle,
            hasBreakpoint: !cloned && bpSet.has(lookupId),
            groupCount: cloned ? 0 : myGroups.length,
            cartesianIterations: cloned ? 1 : cartesian,
            isStart: !cloned && startNodeIds.includes(lookupId),
            caseVariantCount: cloned ? 0 : (anchor?.variants.length ?? 0),
            caseAnchorColor: cloned ? undefined : anchor?.backgroundColor,
          },
        };
      })
    );
    setEdges((current) =>
      current.map((e) => {
        const from = resolveResult(e.source);
        const to = resolveResult(e.target);
        const fromStatus = from.result?.status;
        const toStatus = to.result?.status;
        const offBranch = from.offBranch || to.offBranch;
        const active = !offBranch && (fromStatus === 'running'
          || (fromStatus === 'succeeded' && (toStatus === 'pending' || toStatus === 'running')));
        const traversed = !offBranch && fromStatus === 'succeeded'
          && (toStatus === 'succeeded' || toStatus === 'running' || toStatus === 'failed');
        const cls = [traversed ? 'edge-traversed' : '', offBranch ? 'edge-off-branch' : '']
          .filter(Boolean).join(' ');
        return {
          ...e,
          animated: active,
          className: cls,
        };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, breakpoints, groups, caseSets, startNodeIds, selectedBranchKey]);

  const selectedApiNode = apiNodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEndpoint = selectedApiNode
    ? endpointLookup.get(`${selectedApiNode.method.toUpperCase()} ${normalisePath(selectedApiNode.path)}`)
    : undefined;
  const inspectorSize = useResizableWidth('utopia.inspector.width', 480, 320, 900);

  function patchApiNode(id: string, patch: Partial<ApiNode>) {
    setApiNodes((cur) => cur.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    setDirty(true);
  }

  function toggleBreakpoint(nodeId: string) {
    setBreakpoints((cur) => {
      const found = cur.find((b) => b.nodeId === nodeId);
      if (found) return cur.filter((b) => b.nodeId !== nodeId);
      return [...cur, { nodeId, enabled: true }];
    });
    setDirty(true);
  }

  function toggleStartNode(nodeId: string) {
    setStartNodeIds((cur) => (cur.includes(nodeId) ? cur.filter((x) => x !== nodeId) : [...cur, nodeId]));
    setDirty(true);
  }

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) { setErr('cannot connect a node to itself'); return; }
      setEdges((current) => {
        if (current.some((e) => e.source === conn.source && e.target === conn.target)) {
          setErr(`edge ${conn.source} → ${conn.target} already exists`);
          return current;
        }
        if (wouldCreateCycle(current, conn.source!, conn.target!)) {
          setErr(`cycle blocked: ${conn.source} → ${conn.target}`);
          return current;
        }
        setErr(null); setDirty(true);
        return addEdge({ ...conn, id: `e-${Date.now()}-${conn.source}-${conn.target}` }, current);
      });
    },
    [setEdges]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(ENDPOINT_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(ENDPOINT_DRAG_MIME);
      if (!raw) return;
      let ep: EndpointDescriptor;
      try { ep = JSON.parse(raw); } catch { return; }

      // RF treats node.position as top-left. Shift by half the assumed size so the cursor
      // lands on the node's centre — keeps drop-into-tight-areas membership working.
      const drop = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const position = { x: drop.x - NEW_NODE_W / 2, y: drop.y - NEW_NODE_H / 2 };
      const id = nextNodeId(nodes, ep.method, ep.path);

      // Seed the new ApiNode with declared params + first body sample/example.
      const seeded = seedFromEndpoint(id, ep);
      setApiNodes((cur) => [...cur, seeded]);

      setNodes((cur) => [
        ...cur,
        {
          id, type: 'api', position,
          data: {
            label: id, method: ep.method.toUpperCase(), path: normalisePath(ep.path),
            status: 'pending', idle: true,
          },
        },
      ]);
      setDirty(true);
      setSelectedNodeId(id);
    },
    [nodes, screenToFlowPosition, setNodes]
  );

  function deleteNode(nodeId: string) {
    setNodes((cur) => cur.filter((n) => n.id !== nodeId));
    setEdges((cur) => cur.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setApiNodes((cur) => cur.filter((n) => n.id !== nodeId));
    setBreakpoints((cur) => cur.filter((b) => b.nodeId !== nodeId));
    setStartNodeIds((cur) => cur.filter((x) => x !== nodeId));
    setGroups((cur) => cur
      .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((x) => x !== nodeId), mutations: g.mutations?.filter((m) => m.nodeId !== nodeId) }))
      .filter((g) => g.nodeIds.length > 0));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
    setDirty(true);
  }

  function createEmptyGroupAt(canvasX: number, canvasY: number) {
    const id = `group-${Date.now().toString(36)}`;
    const bounds = { x: canvasX - 110, y: canvasY - 60, width: 220, height: 120 };
    const newGroup: ExecutionGroup = {
      id, nodeIds: [], bounds,
      backgroundColor: colorForGroup(id),
      repeat: { count: 1 }, mutations: [],
    };
    setGroups((cur) => [...cur, newGroup]);
    setNodes((cur) => [
      {
        id: groupRfId(id),
        type: 'groupArea',
        position: { x: bounds.x, y: bounds.y },
        style: { width: bounds.width, height: bounds.height, zIndex: -1 },
        data: { label: id, color: newGroup.backgroundColor, count: 1 } as GroupAreaData,
        draggable: true,
        selectable: true,
      },
      ...cur,
    ]);
    setDirty(true);
    setEditingGroupId(id);
  }

  function createGroupFromSelection() {
    if (selectedIds.length === 0) return;
    // Compute bounding box of selected api nodes; pad so the rectangle visibly contains them.
    const selectedRfNodes = nodes.filter((n) => selectedIds.includes(n.id) && isApiRf(n));
    if (selectedRfNodes.length === 0) return;
    const PAD = 30;
    const minX = Math.min(...selectedRfNodes.map((n) => n.position.x)) - PAD;
    const minY = Math.min(...selectedRfNodes.map((n) => n.position.y)) - PAD;
    const maxX = Math.max(...selectedRfNodes.map((n) => n.position.x + (n.measured?.width ?? 220))) + PAD;
    const maxY = Math.max(...selectedRfNodes.map((n) => n.position.y + (n.measured?.height ?? 80))) + PAD;
    const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

    const id = `group-${Date.now().toString(36)}`;
    const newGroup: ExecutionGroup = {
      id,
      nodeIds: [...selectedIds],
      bounds,
      backgroundColor: colorForGroup(id),
      repeat: { count: 1 },
      mutations: [],
    };
    setGroups((cur) => [...cur, newGroup]);

    // Add the visual area as a low-z RF node so the user can resize / drag it.
    setNodes((cur) => [
      {
        id: groupRfId(id),
        type: 'groupArea',
        position: { x: bounds.x, y: bounds.y },
        style: { width: bounds.width, height: bounds.height, zIndex: -1 },
        data: { label: id, color: newGroup.backgroundColor, count: 1 } as GroupAreaData,
        draggable: true,
        selectable: true,
      },
      ...cur,
    ]);
    setDirty(true);
    setEditingGroupId(id);
  }

  function deleteGroup(groupId: string) {
    setGroups((cur) => cur.filter((g) => g.id !== groupId));
    setNodes((cur) => cur.filter((n) => !(isGroupRfNode(n) && groupIdFromRf(n.id) === groupId)));
    setDirty(true);
  }

  function updateGroup(next: ExecutionGroup) {
    setGroups((cur) => cur.map((g) => (g.id === next.id ? next : g)));
    setNodes((cur) => cur.map((n) =>
      isGroupRfNode(n) && groupIdFromRf(n.id) === next.id
        ? { ...n, data: { ...(n.data as GroupAreaData), label: next.label ?? next.id, color: next.backgroundColor ?? colorForGroup(next.id), count: next.repeat?.count } }
        : n
    ));
    setDirty(true);
  }

  function deleteEdge(edgeId: string) {
    setEdges((cur) => cur.filter((e) => e.id !== edgeId));
    setDirty(true);
  }

  async function onSave() {
    setSaving(true); setErr(null);
    try {
      // Resolve final group bounds + geometric membership from the live RF state.
      const groupRf = nodes.filter(isGroupRfNode);
      const apiRf = nodes.filter(isApiRf);
      const resolvedGroups: ExecutionGroup[] = groups.map((g) => {
        const rf = groupRf.find((n) => groupIdFromRf(n.id) === g.id);
        const bounds = rf
          ? {
              x: rf.position.x,
              y: rf.position.y,
              width: (rf.style?.width as number | undefined) ?? rf.measured?.width ?? g.bounds?.width ?? 200,
              height: (rf.style?.height as number | undefined) ?? rf.measured?.height ?? g.bounds?.height ?? 120,
            }
          : g.bounds;
        // Geometric membership: api nodes whose centre falls inside the rectangle.
        const memberIds = bounds
          ? apiRf
              .filter((n) => {
                const w = n.measured?.width ?? NEW_NODE_W;
                const h = n.measured?.height ?? NEW_NODE_H;
                const cx = n.position.x + w / 2;
                const cy = n.position.y + h / 2;
                return cx >= bounds.x && cx <= bounds.x + bounds.width
                    && cy >= bounds.y && cy <= bounds.y + bounds.height;
              })
              .map((n) => n.id)
          : g.nodeIds;
        return { ...g, bounds, nodeIds: memberIds };
      });

      // Snapshot RF positions back into ApiNode.position so they survive reload.
      const rfPosById = new Map(apiRf.map((n) => [n.id, n.position] as const));
      const nodesWithPos = apiNodes.map((n) => {
        const p = rfPosById.get(n.id);
        return p ? { ...n, position: { x: p.x, y: p.y } } : n;
      });

      const merged: Scenario = {
        ...scenario,
        name: flowName.trim() || scenario.name,
        description: flowDescription.trim() || undefined,
        tags: flowTags.filter((t) => t.trim().length > 0),
        nodes: nodesWithPos,
        // Strip synthetic per-branch fan-out edges before persisting; only the canonical
        // user-authored edges round-trip through the backend.
        edges: edges.filter((e) => !isBranchCloneEdge(e)).map((e) => ({ from: e.source, to: e.target, mode: 'sequential' })),
        breakpoints,
        startNodeIds,
        groups: resolvedGroups,
        caseSets,
      };
      setGroups(resolvedGroups);
      await saveScenario(merged);
      setDirty(false);
      setLastSavedAt(Date.now());
      setErr(null);
      onSaved(merged);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  // Latest onSave reference for cleanup-time force-saves (scenario swap).
  useEffect(() => { onSaveRef.current = onSave; });

  // Debounced auto-save. Re-armed by every dependency change; cleanup cancels
  // a pending fire if a new edit lands within the window. Skips while running
  // (run engine writes ephemeral state) or while a save is already in flight
  // (prevents overlap; the post-save dirty flip will re-arm if needed). Backoff
  // bumps to 5s when the last attempt errored to avoid hammering a downed host.
  useEffect(() => {
    if (!dirty || running || saving) return;
    const delay = err ? 5000 : 800;
    const t = setTimeout(() => { void onSave(); }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, running, saving, err,
      apiNodes, breakpoints, startNodeIds, groups, caseSets,
      flowName, flowDescription, flowTags, nodes, edges]);

  // 1s tick drives the "Saved · Ns ago" relative timestamp; pauses when the
  // tab is hidden so we aren't re-rendering off-screen.
  useEffect(() => {
    if (lastSavedAt == null) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(() => setNowTick((n) => n + 1), 1000);
    };
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };
    const onVis = () => (document.visibilityState === 'hidden' ? stop() : start());
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [lastSavedAt]);

  function onAutoLayout() {
    setNodes((cur) => autoLayout(cur, edges));
    setDirty(true);
  }

  async function onStart() {
    setErr(null);
    // Auto-save handles edits within 800ms, but the user may hit Run faster.
    // Force-save synchronously so the run sees the latest scenario.
    if (dirty) {
      try { await onSave(); } catch { return; /* err state already set */ }
    }
    setRunning(true);
    try {
      const authOpts = authToRunOptions(auth);
      const started = await startRun(scenario.id, {
        breakpointsEnabled: true,
        headers: authOpts.headers,
        queryParameters: authOpts.queryParameters,
      });
      setRun(started);
      unsubRef.current?.();
      unsubRef.current = subscribeRunEvents(started.id, handleEvent, () => {
        getRun(started.id).then(setRun).catch(() => {});
      });
    } catch (e) {
      setErr((e as Error).message); setRunning(false);
    }
  }

  function handleEvent(evt: RunEvent) {
    if (evt.type === 'snapshot') {
      const snapshot = evt.payload as Run;
      setRun(snapshot);
      if (snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        setRunning(false);
      }
      return;
    }
    if (evt.type === 'runStarted') { setRun(evt.payload as Run); return; }
    if (evt.type === 'runFinished') {
      setRun(evt.payload as Run); setRunning(false);
      unsubRef.current?.(); unsubRef.current = null;
      return;
    }
    const result = evt.payload as NodeResult | undefined;
    if (!result || !evt.nodeId) return;
    const evtKey = (evt.branchPath ?? []).join('/');
    setRun((prev) => {
      if (!prev) return prev;
      // Upsert by (nodeId, branchKey). Newly forked branches just append.
      const others = prev.nodeResults.filter(
        (r) => !(r.nodeId === evt.nodeId && branchKey(r) === evtKey)
      );
      return {
        ...prev,
        nodeResults: [...others, result],
        status: evt.type === 'nodePaused' ? 'paused' : prev.status,
        pausedAtNodeId: evt.type === 'nodePaused' ? evt.nodeId
          : (evt.type === 'nodeResumed' ? undefined : prev.pausedAtNodeId),
      };
    });
  }

  async function onResolveBreakpoint(action: 'resume' | 'skip' | 'abort') {
    if (!run?.pausedAtNodeId) return;
    try {
      const r = await fetch(
        `/apicover/api/runs/${encodeURIComponent(run.id)}/breakpoints/${encodeURIComponent(run.pausedAtNodeId)}/resolve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      if ('ctrlKey' in e && (e as MouseEvent).ctrlKey) return;
      const me = e as MouseEvent;
      setMenu({
        x: me.clientX, y: me.clientY,
        items: [
          { label: 'Canvas', header: true },
          { label: running ? '● running…' : '▶ Run', onClick: onStart, disabled: running || saving },
          { label: '⌘ Auto-layout', onClick: onAutoLayout },
          { separator: true },
          {
            label: '⊞ New empty group here',
            onClick: () => {
              const pos = screenToFlowPosition({ x: me.clientX, y: me.clientY });
              createEmptyGroupAt(pos.x, pos.y);
            },
          },
          { separator: true },
          { label: '↻ Refresh status', onClick: () => run && getRun(run.id).then(setRun).catch(() => {}), disabled: !run },
          { label: '✕ Clear run state', onClick: () => { setRun(null); setErr(null); } },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, dirty, saving, run, screenToFlowPosition]
  );

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: RFNode) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      // Group area right-click → group menu, not the api-node menu.
      if (isGroupRfNode(node)) {
        const gid = groupIdFromRf(node.id);
        const grp = groups.find((g) => g.id === gid);
        if (grp) {
          setMenu({
            x: e.clientX, y: e.clientY,
            items: [
              { label: `Group: ${grp.label ?? grp.id}`, header: true },
              { label: '⚙ Settings…', onClick: () => setEditingGroupId(grp.id) },
              { separator: true },
              { label: '🗑 Delete group', danger: true, onClick: () => deleteGroup(grp.id) },
            ],
          });
        }
        return;
      }
      // Branch clones share menu actions with their underlying node — breakpoint, start
      // marker, etc. all key off the canonical node id, not the synthetic clone id.
      const cloned = parseBranchCloneRf(node.id);
      const canonicalId = cloned ? cloned.nodeId : node.id;
      const data = node.data as ApiNodeData;
      const result = cloned
        ? getNodeResult(run, canonicalId, cloned.branchKey)
        : aggregateNodeResult(run, canonicalId);
      const isPaused = result?.status === 'paused';
      const hasBp = breakpoints.some((b) => b.nodeId === canonicalId);
      const isStart = startNodeIds.includes(canonicalId);
      const myGroup = groups.find((g) => g.nodeIds.includes(canonicalId));
      const myCaseSet = caseSets.find((c) => c.anchorNodeId === canonicalId);
      const itemsForCases: MenuItem[] = [
        { separator: true },
        myCaseSet
          ? { label: '⑂ Edit cases…', onClick: () => setSelectedNodeId(node.id) }
          : {
              label: '⑂ Add case set',
              onClick: () => {
                const fresh: CaseSet = {
                  id: `cs-${node.id}-${Date.now().toString(36)}`,
                  anchorNodeId: node.id,
                  variants: [
                    { id: 'v1', label: 'variant 1', overrides: [] },
                    { id: 'v2', label: 'variant 2', overrides: [] },
                  ],
                };
                setCaseSets((cur) => [...cur.filter((c) => c.anchorNodeId !== node.id), fresh]);
                setDirty(true);
                setSelectedNodeId(node.id);
              },
            },
        {
          label: '⑂ Remove cases',
          danger: true,
          disabled: !myCaseSet,
          onClick: () => {
            if (!myCaseSet) return;
            setCaseSets((cur) => cur.filter((c) => c.anchorNodeId !== node.id));
            setDirty(true);
          },
        },
      ];
      const itemsForGroupAware: MenuItem[] = myGroup
        ? [
            { separator: true },
            { label: `Group: ${myGroup.label ?? myGroup.id}`, header: true },
            { label: '⚙ Group settings…', onClick: () => setEditingGroupId(myGroup.id) },
            { label: '✕ Remove from group', onClick: () => {
              const nextNodes = myGroup.nodeIds.filter((x) => x !== node.id);
              if (nextNodes.length === 0) deleteGroup(myGroup.id);
              else updateGroup({ ...myGroup, nodeIds: nextNodes, mutations: myGroup.mutations?.filter((m) => m.nodeId !== node.id) });
            }},
          ]
        : (selectedIds.length > 1 && selectedIds.includes(node.id))
          ? [
              { separator: true },
              { label: `${selectedIds.length} nodes selected`, header: true },
              { label: '⊞ Create group from selection', onClick: createGroupFromSelection },
            ]
          : [];

      const epForNode = endpointLookup.get(`${data.method.toUpperCase()} ${normalisePath(data.path)}`);
      setMenu({
        x: e.clientX, y: e.clientY,
        items: [
          { label: `Node: ${node.id}`, header: true },
          { label: `${data.method} ${data.path}`, header: true },
          { separator: true },
          { label: '⚡ Quick Call', onClick: () => epForNode && setQuickCallEp(epForNode), disabled: !epForNode },
          { label: '✏ Edit (open inspector)', onClick: () => setSelectedNodeId(canonicalId) },
          { label: hasBp ? '● Remove breakpoint' : '○ Add breakpoint', onClick: () => toggleBreakpoint(canonicalId) },
          { label: isStart ? '○ Unset start node' : '◉ Set as start node', onClick: () => toggleStartNode(canonicalId) },
          ...itemsForGroupAware,
          ...itemsForCases,
          { separator: true },
          { label: 'Resume', onClick: () => onResolveBreakpoint('resume'), disabled: !isPaused },
          { label: 'Skip',   onClick: () => onResolveBreakpoint('skip'),   disabled: !isPaused },
          { label: 'Abort run', onClick: () => onResolveBreakpoint('abort'), danger: true, disabled: !isPaused },
          { separator: true },
          {
            label: 'Copy response JSON',
            disabled: !result?.response?.body,
            onClick: () => result?.response?.body !== undefined &&
              navigator.clipboard.writeText(JSON.stringify(result.response.body, null, 2)).catch(() => {}),
          },
          { label: 'Copy node id', onClick: () => navigator.clipboard.writeText(node.id).catch(() => {}) },
          { separator: true },
          { label: '🗑 Delete node', danger: true, onClick: () => deleteNode(canonicalId) },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, breakpoints, startNodeIds, groups, selectedIds]
  );

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: RFEdge) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      setMenu({
        x: e.clientX, y: e.clientY,
        items: [
          { label: `Edge: ${edge.source} → ${edge.target}`, header: true },
          { label: '🗑 Delete edge', danger: true, onClick: () => deleteEdge(edge.id) },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="canvas-wrap">
      {quickCallEp && (
        <QuickCallPanel endpoint={quickCallEp} onClose={() => setQuickCallEp(null)} />
      )}
      <FlowHeader
        name={flowName}
        description={flowDescription}
        tags={flowTags}
        onNameChange={(v) => { setFlowName(v); setDirty(true); }}
        onDescriptionChange={(v) => { setFlowDescription(v); setDirty(true); }}
        onTagsChange={(v) => { setFlowTags(v); setDirty(true); }}
      />
      <div className="canvas-toolbar">
        <button className="btn primary" onClick={onStart} disabled={running || saving}>
          {running ? '● running…' : '▶ Run'}
        </button>
        <SaveStatus
          dirty={dirty}
          saving={saving}
          err={err}
          lastSavedAt={lastSavedAt}
          nowTick={nowTick}
          onForceSave={onSave}
        />
        <button className="btn" onClick={onAutoLayout}>⌘ Layout</button>
        {run && (
          <span className={`run-status status-${run.status}`}>
            run {run.id.slice(0, 8)} · {run.status}
          </span>
        )}
        {run?.status === 'paused' && (
          <span className="bp-actions">
            <button onClick={() => onResolveBreakpoint('resume')}>resume</button>
            <button onClick={() => onResolveBreakpoint('skip')}>skip</button>
            <button onClick={() => onResolveBreakpoint('abort')} className="danger">abort</button>
          </span>
        )}
        {branchKeys.length > 0 && (
          <div
            className="branch-picker"
            role="tablist"
            aria-label="branch view"
            title="filter canvas to a single branch's run results"
          >
            <span className="branch-picker-label">branches</span>
            <button
              type="button"
              className={`branch-chip ${selectedBranchKey == null ? 'is-active' : ''}`}
              onClick={() => setSelectedBranchKey(null)}
              role="tab"
              aria-selected={selectedBranchKey == null}
            >
              all <span className="branch-chip-count">{branchKeys.length}</span>
            </button>
            {branchKeys.map((k) => {
              const status = aggregateBranchStatus(run, k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`branch-chip status-${status} ${selectedBranchKey === k ? 'is-active' : ''}`}
                  onClick={() => setSelectedBranchKey(k)}
                  role="tab"
                  aria-selected={selectedBranchKey === k}
                  title={k}
                >
                  <span className={`branch-chip-dot status-${status}`} />
                  {branchLabelFor(k) || k}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selectedIds.length > 1 && !groups.some((g) => g.nodeIds.some((nid) => selectedIds.includes(nid))) && (
        <div className="selection-bar">
          <span>{selectedIds.length} nodes selected</span>
          <button className="btn primary" onClick={createGroupFromSelection}>⊞ Create group</button>
        </div>
      )}
      {selectedGroupId && (
        <div className="selection-bar">
          <span>Group: {groups.find((g) => g.id === selectedGroupId)?.label ?? selectedGroupId}</span>
          <button className="btn primary" onClick={() => setEditingGroupId(selectedGroupId)}>⚙ Settings</button>
          <button className="btn danger-btn" onClick={() => deleteGroup(selectedGroupId)}>🗑 Delete</button>
        </div>
      )}
      {editingGroupId && groups.find((g) => g.id === editingGroupId) && (
        <GroupSettingsModal
          initial={groups.find((g) => g.id === editingGroupId)!}
          groupNodeIds={groups.find((g) => g.id === editingGroupId)!.nodeIds}
          onSave={(next) => updateGroup(next)}
          onDelete={() => deleteGroup(editingGroupId)}
          onClose={() => setEditingGroupId(null)}
        />
      )}
      <BranchDiagram
        run={run}
        nodes={apiNodes}
        edges={edges.filter((e) => !isBranchCloneEdge(e)).map((e) => ({ from: e.source, to: e.target, mode: 'sequential' as const }))}
        caseSets={caseSets}
        groups={groups}
        selectedBranchKey={selectedBranchKey}
        onSelectBranch={setSelectedBranchKey}
        onFocusNode={(id, key) => {
          setSelectedBranchKey(key);
          setSelectedNodeId(id);
        }}
      />
      <div className="canvas-row">
        <div
          className="canvas-flow"
          ref={wrapperRef}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onContextMenu={(e) => {
            // Catch-all: suppress browser native menu over the canvas regardless of source.
            // RF's per-element handlers still get to choose whether to render our custom menu.
            e.preventDefault();
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type === 'remove' || c.type === 'position')) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === 'remove')) setDirty(true);
            }}
            onConnect={onConnect}
            onNodeClick={(_e, n) => {
              if (isStructuralRf(n)) { setSelectedNodeId(null); return; }
              const cloned = parseBranchCloneRf(n.id);
              if (cloned) {
                // Clicking a clone pins its branch + opens the underlying node in the inspector.
                setSelectedBranchKey(cloned.branchKey);
                setSelectedNodeId(cloned.nodeId);
                return;
              }
              setSelectedNodeId(n.id);
            }}
            onPaneClick={() => setSelectedNodeId(null)}
            onSelectionChange={({ nodes: sel }) => {
              setSelectedIds(sel.filter(isApiRf).map((n) => n.id));
              const gnode = sel.find(isGroupRfNode);
              setSelectedGroupId(gnode ? groupIdFromRf(gnode.id) : null);
            }}
            onPaneContextMenu={onPaneContextMenu}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            fitView
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
            selectionKeyCode="Shift"
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        </div>
        {selectedApiNode && (
          <div
            className="resize-handle vertical inspector-resize"
            onMouseDown={(e) => inspectorSize.startResize(e, 'left')}
            title="Drag to resize inspector"
          />
        )}
        {selectedApiNode && (() => {
          const key = `${selectedApiNode.method.toUpperCase()} ${normalisePath(selectedApiNode.path)}`;
          const usingScenarios = scenariosUsingEndpoint?.get(key) ?? [];
          const statBucket = endpointStatsByKey?.get(key);
          const scenariosUsing = usingScenarios.map((s) => {
            const per = statBucket?.perScenario.get(s.id);
            return { id: s.id, name: s.name, passed: per?.passed ?? 0, failed: per?.failed ?? 0 };
          });
          const endpointTotals = { passed: statBucket?.passed ?? 0, failed: statBucket?.failed ?? 0 };
          return (
            <NodeInspector
              node={selectedApiNode}
              width={inspectorSize.width}
              endpoint={selectedEndpoint}
              isStartNode={startNodeIds.includes(selectedApiNode.id)}
              groupsForNode={groups.filter((g) => g.nodeIds.includes(selectedApiNode.id))}
              iterations={aggregateNodeResult(run, selectedApiNode.id)?.iterations}
              siblings={apiNodes.filter((n) => n.id !== selectedApiNode.id)}
              upstreamIds={edges.filter((e) => e.target === selectedApiNode.id).map((e) => e.source)}
              downstreamIds={edges.filter((e) => e.source === selectedApiNode.id).map((e) => e.target)}
              scenariosUsing={scenariosUsing}
              endpointTotals={endpointTotals}
              scenarioName={scenario.name}
              onChange={(next) => patchApiNode(selectedApiNode.id, next)}
              onToggleStartNode={() => toggleStartNode(selectedApiNode.id)}
              onClose={() => setSelectedNodeId(null)}
              onFocusNode={(id) => setSelectedNodeId(id)}
              onEditGroup={(gid) => setEditingGroupId(gid)}
              enableCallGraph={enableCallGraph}
              caseSetForNode={caseSets.find((c) => c.anchorNodeId === selectedApiNode.id)}
              onCaseSetChange={(next) => {
                setDirty(true);
                setCaseSets((cur) => {
                  const others = cur.filter((c) => c.anchorNodeId !== selectedApiNode.id);
                  return next ? [...others, next] : others;
                });
              }}
            />
          );
        })()}
      </div>
    </div>
  );
}

function buildFromScenario(scenario: Scenario): { nodes: RFNode[]; edges: RFEdge[] } {
  const apiNodes: RFNode<ApiNodeData>[] = scenario.nodes.map((n) => ({
    id: n.id,
    type: 'api',
    position: n.position ? { x: n.position.x, y: n.position.y } : { x: 0, y: 0 },
    data: {
      label: n.label ?? n.id,
      method: n.method.toUpperCase(),
      path: n.path,
      status: 'pending',
      idle: true,
    },
  }));
  const validNodeIds = new Set(scenario.nodes.map((n) => n.id));
  const edges: RFEdge[] = scenario.edges
    // Drop stale synthetic per-branch fan-out edges that may have leaked into a saved
    // scenario from a pre-fix build (their `from`/`to` reference clone ids like `node@@key`).
    .filter((e) => validNodeIds.has(e.from) && validNodeIds.has(e.to))
    .map((e, i) => ({
      id: `e-${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
    }));
  // Use persisted positions when every node has one; otherwise run dagre auto-layout.
  const allPersisted = scenario.nodes.length > 0 && scenario.nodes.every((n) => !!n.position);
  const laidApi = allPersisted ? apiNodes : autoLayout(apiNodes, edges);

  const groupNodes: RFNode<GroupAreaData>[] = (scenario.groups ?? [])
    .filter((g) => g.bounds)
    .map((g) => ({
      id: groupRfId(g.id),
      type: 'groupArea',
      position: { x: g.bounds!.x, y: g.bounds!.y },
      style: { width: g.bounds!.width, height: g.bounds!.height, zIndex: -1 },
      data: {
        label: g.label ?? g.id,
        color: g.backgroundColor ?? colorForGroup(g.id),
        count: g.repeat?.count,
      },
      draggable: true,
      selectable: true,
    }));

  return { nodes: [...groupNodes, ...laidApi], edges };
}

const GROUP_RF_PREFIX = 'group::';
function groupRfId(id: string): string { return `${GROUP_RF_PREFIX}${id}`; }
function isGroupRfNode(n: RFNode): boolean { return n.id.startsWith(GROUP_RF_PREFIX); }
function groupIdFromRf(rfId: string): string { return rfId.slice(GROUP_RF_PREFIX.length); }

const CASE_RF_PREFIX = 'case::';
function caseRfId(id: string): string { return `${CASE_RF_PREFIX}${id}`; }
function isCaseRfNode(n: RFNode): boolean { return n.id.startsWith(CASE_RF_PREFIX); }
function caseIdFromRf(rfId: string): string { return rfId.slice(CASE_RF_PREFIX.length); }
function isStructuralRf(n: RFNode): boolean { return isGroupRfNode(n) || isCaseRfNode(n); }

// Branch clones: synthetic api-node copies spawned per branch so the canvas literally shows
// each iteration as a separate node fanned out from its original. Encoded as
// `<originalNodeId>@@<branchKey>` in the RF id space; original `apiNodes[]` is unaware.
const BRANCH_CLONE_SEP = '@@';
const BRANCH_EDGE_PREFIX = 'bedge::';
const BRANCH_LANE_SPREAD = 280;
function branchCloneRfId(nodeId: string, branchKey: string): string {
  return `${nodeId}${BRANCH_CLONE_SEP}${branchKey}`;
}
function parseBranchCloneRf(rfId: string): { nodeId: string; branchKey: string } | null {
  const idx = rfId.indexOf(BRANCH_CLONE_SEP);
  if (idx < 0) return null;
  return { nodeId: rfId.slice(0, idx), branchKey: rfId.slice(idx + BRANCH_CLONE_SEP.length) };
}
function isBranchCloneRf(n: RFNode): boolean { return parseBranchCloneRf(n.id) !== null; }
function isBranchCloneEdge(e: RFEdge): boolean { return e.id.startsWith(BRANCH_EDGE_PREFIX); }
function branchCloneEdgeId(origEdgeId: string, branchKey: string): string {
  return `${BRANCH_EDGE_PREFIX}${branchKey}::${origEdgeId}`;
}
/** True when this is a real, user-authored api node (not a structural rectangle or branch clone). */
function isApiRf(n: RFNode): boolean { return !isStructuralRf(n) && !isBranchCloneRf(n); }

/** BFS over edges from the anchor; returns set of reachable node ids (including the anchor). */
function collectDescendants(anchorId: string, edges: RFEdge[]): Set<string> {
  const out = new Set<string>([anchorId]);
  const queue = [anchorId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.source === cur && !out.has(e.target)) {
        out.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return out;
}

function seedFromEndpoint(id: string, ep: EndpointDescriptor): ApiNode {
  const pathParameters: Record<string, unknown> = {};
  const queryParameters: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};

  for (const p of ep.parameters ?? []) {
    const v = p.defaultValue !== undefined ? p.defaultValue : '';
    if (p.in === 'path') pathParameters[p.name] = v;
    else if (p.in === 'query') queryParameters[p.name] = v;
    else if (p.in === 'header') headers[p.name] = v;
  }

  let body: unknown;
  const sample = ep.samples?.[0]?.jsonPayload;
  if (sample) {
    try { body = JSON.parse(sample); } catch { body = sample; }
  } else {
    const example = ep.requestBody?.content?.[0]?.example;
    if (example !== undefined) body = example;
  }

  return {
    id,
    method: ep.method.toUpperCase(),
    path: normalisePath(ep.path),
    pathParameters,
    queryParameters,
    headers,
    body,
  };
}

/** Map a group id to one of N predefined ring colour buckets so multiple groups read distinct. */
function groupHashClass(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}

function nextNodeId(existing: RFNode[], method: string, path: string): string {
  const slug = `${method.toLowerCase()}_${path}`
    .replace(/[{}]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const taken = new Set(existing.map((n) => n.id));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}_${Date.now()}`;
}

interface SaveStatusProps {
  dirty: boolean;
  saving: boolean;
  err: string | null;
  lastSavedAt: number | null;
  nowTick: number;
  onForceSave: () => void;
}

function SaveStatus({ dirty, saving, err, lastSavedAt, nowTick, onForceSave }: SaveStatusProps) {
  void nowTick; // prop forces re-render every tick; value is read via Date.now()
  let label: string;
  let mod: string;
  let clickable = true;
  if (saving) {
    label = 'Saving…';
    mod = 'is-saving';
    clickable = false;
  } else if (err) {
    label = 'Save failed — click to retry';
    mod = 'is-error';
  } else if (dirty) {
    label = 'Unsaved changes…';
    mod = 'is-unsaved';
  } else if (lastSavedAt != null) {
    label = `Saved · ${formatAgo(Date.now() - lastSavedAt)}`;
    mod = 'is-saved';
  } else {
    return null;
  }
  return (
    <button
      className={`save-status ${mod}`}
      onClick={clickable ? onForceSave : undefined}
      disabled={!clickable}
      title={err ?? (clickable ? 'Click to save now' : '')}
    >
      <span className="save-status-dot" />{label}
    </button>
  );
}

/** Roll up a branch's per-node statuses into one chip status. */
function aggregateBranchStatus(run: Run | null, key: string): 'running' | 'failed' | 'succeeded' | 'pending' {
  if (!run) return 'pending';
  const results = run.nodeResults.filter((r) => branchKey(r) === key);
  if (results.length === 0) return 'pending';
  if (results.some((r) => r.status === 'running' || r.status === 'paused')) return 'running';
  if (results.some((r) => r.status === 'failed')) return 'failed';
  if (results.every((r) => r.status === 'succeeded')) return 'succeeded';
  return 'pending';
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
