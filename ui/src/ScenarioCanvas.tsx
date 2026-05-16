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
import { type GroupAreaData } from './GroupAreaNode';
import { type CaseAreaData } from './CaseAreaNode';
import { ENDPOINT_DRAG_MIME } from './EndpointPalette';
import { InspectorPanel } from './inspector/InspectorPanel';
import { useCanvasContextMenus } from './canvas/CanvasContextMenus';
import { useDirtyTracking } from './hooks/useDirtyTracking';
import { useGroupMembership } from './hooks/useGroupMembership';
import { useNodeStatusOverlay } from './hooks/useNodeStatusOverlay';
import { useRunExecution } from './hooks/useRunExecution';
import { useBranchClones } from './hooks/useBranchClones';
import { type AuthConfig } from './auth';
import { GroupSettingsModal } from './GroupSettingsModal';
import { autoLayout } from './layout';
import { wouldCreateCycle } from './dag';
import { normalisePath } from './App';
import { useVisibilityTicker } from './hooks/useVisibilityTicker';
import { FlowHeader } from './FlowHeader';
import { RunHistoryPanel } from './RunHistoryPanel';
import { BranchDiagram } from './inspector/BranchDiagram';
import { QuickCallPanel } from './QuickCallPanel';
import {
  saveScenario,
  type ApiNode,
  type Breakpoint,
  type CaseSet,
  type EndpointDescriptor,
  type ExecutionGroup,
  type Scenario,
} from './api';
import {
  NEW_NODE_H,
  NEW_NODE_W,
  aggregateBranchStatus,
  buildFromScenario,
  caseIdFromRf,
  caseRfId,
  collectDescendants,
  colorForGroup,
  formatAgo,
  groupIdFromRf,
  groupRfId,
  isApiRf,
  isBranchCloneEdge,
  isCaseRfNode,
  isGroupRfNode,
  isStructuralRf,
  nextNodeId,
  nodeTypes,
  parseBranchCloneRf,
  seedFromEndpoint,
} from './canvas/scenarioCanvasUtils';

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
  const [err, setErr] = useState<string | null>(null);
  // Lazy bridges between useRunExecution (consumes a "force save" callback) and
  // useDirtyTracking (produces dirtyRef + saveRef). Both refs are populated below
  // after useDirtyTracking runs; callbacks defined here only dereference them at
  // call time, after init is complete.
  const dirtyRefBridge = useRef<{ current: boolean }>({ current: false });
  const saveRefBridge = useRef<() => Promise<void>>(async () => {});
  const forceSaveIfDirty = useCallback(async () => {
    if (dirtyRefBridge.current.current) {
      try { await saveRefBridge.current(); } catch { throw new Error('save-failed'); }
    }
  }, []);
  const runExec = useRunExecution({
    scenarioId: scenario.id,
    auth,
    forceSaveIfDirty,
    onError: setErr,
  });
  const { run, setRun, running, historyTick, sseStatus, start: onStart, resolveBreakpoint: onResolveBreakpoint } = runExec;
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
    setErr(null);
    setDirty(false);
    setLastSavedAt(null);
    setSelectedNodeId(null);
    setSelectedBranchKey(null);
    runExec.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id]);


  useGroupMembership({ nodes, setNodes, setGroups, groups, run });

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

  const branchClones = useBranchClones({
    run, groups, caseSets, apiNodes, setNodes, setEdges,
    selectedBranchKey, setSelectedBranchKey,
  });
  const { branchKeys, branchLabelFor } = branchClones;

  useNodeStatusOverlay({
    run, breakpoints, groups, caseSets, startNodeIds, selectedBranchKey, setNodes, setEdges,
  });

  const selectedApiNode = apiNodes.find((n) => n.id === selectedNodeId) ?? null;

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

      const drop = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = nextNodeId(nodes, ep.method, ep.path);

      // Edge auto-create: if the drop point lands on an existing node, decide which side
      // (top/right/bottom/left) the cursor is closest to. Place the new node just outside
      // that side and wire an edge in the matching direction:
      //   - drop on RIGHT  side → new node to the right,  edge existing → new
      //   - drop on LEFT   side → new node to the left,   edge new → existing
      //   - drop on BOTTOM side → new node below,         edge existing → new
      //   - drop on TOP    side → new node above,         edge new → existing
      const GAP = 60;
      let position = { x: drop.x - NEW_NODE_W / 2, y: drop.y - NEW_NODE_H / 2 };
      let edgeToAdd: { source: string; target: string } | null = null;

      const overNode = nodes.find((n) => {
        const w = n.measured?.width ?? NEW_NODE_W;
        const h = n.measured?.height ?? NEW_NODE_H;
        return drop.x >= n.position.x && drop.x <= n.position.x + w
          && drop.y >= n.position.y && drop.y <= n.position.y + h;
      });

      if (overNode) {
        const w = overNode.measured?.width ?? NEW_NODE_W;
        const h = overNode.measured?.height ?? NEW_NODE_H;
        const cx = overNode.position.x + w / 2;
        const cy = overNode.position.y + h / 2;
        const dx = drop.x - cx;
        const dy = drop.y - cy;
        // Normalise to the node's aspect so a 220×80 box still picks the correct side.
        const nx = dx / (w / 2);
        const ny = dy / (h / 2);
        if (Math.abs(nx) >= Math.abs(ny)) {
          if (nx >= 0) {
            position = { x: overNode.position.x + w + GAP, y: overNode.position.y };
            edgeToAdd = { source: overNode.id, target: id };
          } else {
            position = { x: overNode.position.x - NEW_NODE_W - GAP, y: overNode.position.y };
            edgeToAdd = { source: id, target: overNode.id };
          }
        } else {
          if (ny >= 0) {
            position = { x: overNode.position.x, y: overNode.position.y + h + GAP };
            edgeToAdd = { source: overNode.id, target: id };
          } else {
            position = { x: overNode.position.x, y: overNode.position.y - NEW_NODE_H - GAP };
            edgeToAdd = { source: id, target: overNode.id };
          }
        }
      }

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

      if (edgeToAdd) {
        setEdges((cur) => {
          if (cur.some((x) => x.source === edgeToAdd!.source && x.target === edgeToAdd!.target)) return cur;
          if (wouldCreateCycle(cur, edgeToAdd!.source, edgeToAdd!.target)) return cur;
          return addEdge(
            { ...edgeToAdd!, id: `e-${Date.now()}-${edgeToAdd!.source}-${edgeToAdd!.target}` },
            cur,
          );
        });
      }

      setDirty(true);
      setSelectedNodeId(id);
    },
    [nodes, screenToFlowPosition, setNodes, setEdges]
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
  // Wire dirty tracking + autosave. Watch tuple is the exact 10 dep snapshot from the
  // original inline effect (apiNodes, breakpoints, startNodeIds, groups, caseSets,
  // flowName, flowDescription, flowTags, nodes, edges) — DO NOT reduce or extend without
  // verifying every mutator marks dirty by hand.
  const dirtyTracking = useDirtyTracking({
    running,
    err,
    save: onSave,
    watch: [apiNodes, breakpoints, startNodeIds, groups, caseSets,
            flowName, flowDescription, flowTags, nodes, edges],
  });
  const { dirty, saving, lastSavedAt, setDirty, setSaving, setLastSavedAt, dirtyRef, saveRef: onSaveRef } = dirtyTracking;
  // Bind bridges so the run-execution callback (defined earlier) reads current refs.
  dirtyRefBridge.current = dirtyRef;
  saveRefBridge.current = onSaveRef.current;
  const nowTick = useVisibilityTicker(lastSavedAt != null);

  function onAutoLayout() {
    setNodes((cur) => autoLayout(cur, edges));
    setDirty(true);
  }

  const contextMenus = useCanvasContextMenus(
    {
      running,
      saving,
      run,
      breakpoints,
      startNodeIds,
      groups,
      caseSets,
      selectedIds,
      endpointLookup,
    },
    {
      onStart,
      onAutoLayout,
      createEmptyGroupAt,
      setEditingGroupId,
      deleteGroup,
      toggleBreakpoint,
      toggleStartNode,
      deleteNode,
      createGroupFromSelection,
      updateGroup,
      setSelectedNodeId,
      setQuickCallEp,
      setCaseSets,
      setDirty,
      setRun,
      setErr,
      onResolveBreakpoint,
      deleteEdge,
      screenToFlowPosition,
    },
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
      {running && sseStatus === 'reconnecting' && (
        <div className="sse-reconnect-banner" role="status" aria-live="polite">
          Reconnecting to live run stream…
        </div>
      )}
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
      <RunHistoryPanel scenarioId={scenario.id} refreshTick={historyTick} />
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
            onPaneContextMenu={contextMenus.paneHandler}
            onNodeContextMenu={contextMenus.nodeHandler}
            onEdgeContextMenu={contextMenus.edgeHandler}
            fitView
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
            selectionKeyCode="Shift"
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          {contextMenus.menuElement}
        </div>
        <InspectorPanel
          selectedApiNode={selectedApiNode}
          endpointLookup={endpointLookup}
          scenariosUsingEndpoint={scenariosUsingEndpoint}
          endpointStatsByKey={endpointStatsByKey}
          run={run}
          apiNodes={apiNodes}
          edges={edges}
          groups={groups}
          caseSets={caseSets}
          startNodeIds={startNodeIds}
          scenarioName={scenario.name}
          enableCallGraph={enableCallGraph}
          onPatchNode={(id, patch) => patchApiNode(id, patch)}
          onToggleStart={(id) => toggleStartNode(id)}
          onClose={() => setSelectedNodeId(null)}
          onFocusNode={(id) => setSelectedNodeId(id)}
          onEditGroup={(gid) => setEditingGroupId(gid)}
          onCaseSetChange={(anchorId, next) => {
            setDirty(true);
            setCaseSets((cur) => {
              const others = cur.filter((c) => c.anchorNodeId !== anchorId);
              return next ? [...others, next] : others;
            });
          }}
        />
      </div>
    </div>
  );
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

