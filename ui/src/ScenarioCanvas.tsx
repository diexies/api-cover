import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { type CaseAreaData } from './CaseAreaNode';
import { ENDPOINT_DRAG_MIME } from './EndpointPalette';
import { InspectorPanel } from './inspector/InspectorPanel';
import { useCanvasContextMenus } from './canvas/CanvasContextMenus';
import { useDirtyTracking } from './hooks/useDirtyTracking';
import { useGroupMembership } from './hooks/useGroupMembership';
import { useNodeStatusOverlay } from './hooks/useNodeStatusOverlay';
import { useRunExecution } from './hooks/useRunExecution';
import { useBranchClones } from './hooks/useBranchClones';
import { useScenarioModel } from './hooks/useScenarioModel';
import { useScenarioHistory, type ScenarioSnapshot } from './hooks/useScenarioHistory';
import { usePrefs } from './stores/prefs';
import { type AuthConfig } from './auth';
import { GroupSettingsModal } from './GroupSettingsModal';
import { BulkEditModal } from './BulkEditModal';
import { ScenarioDetailModal } from './ScenarioDetailModal';
import { wouldCreateCycle } from './dag';
import { normalisePath } from './App';
import { useVisibilityTicker } from './hooks/useVisibilityTicker';
import { RunHistoryPanel } from './RunHistoryPanel';
import { BranchDiagram } from './inspector/BranchDiagram';
import { QuickCallPanel } from './QuickCallPanel';
import {
  type ApiNode,
  type EndpointDescriptor,
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
  formatAgo,
  groupIdFromRf,
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // null = aggregate ("all branches"); otherwise a branchKey from the current run.
  const [selectedBranchKey, setSelectedBranchKey] = useState<string | null>(null);
  const [quickCallEp, setQuickCallEp] = useState<EndpointDescriptor | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  // True when a historical run is loaded into the canvas via the history drawer. In this
  // mode mutators no-op (dirty stays false → autosave skipped) and a banner offers Exit.
  const [historicalRunId, setHistoricalRunId] = useState<string | null>(null);
  // Refs that mirror selectedNodeId / selectedIds for the model hook's mutators.
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;
  const selectedIdsRef = useRef<string[]>([]);
  selectedIdsRef.current = selectedIds;
  // Late-bound dirty-tracking setters — bound after useDirtyTracking runs below.
  const dirtyBridge = useRef<(v: boolean) => void>(() => {});
  const savingBridge = useRef<(v: boolean) => void>(() => {});
  const lastSavedAtBridge = useRef<(v: number | null) => void>(() => {});

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

  const model = useScenarioModel({
    scenario, nodes, edges, setNodes, setEdges,
    dirtyBridge, savingBridge, lastSavedAtBridge,
    setErr, onSaved,
    selectedNodeIdRef, setSelectedNodeId,
    selectedIdsRef, setEditingGroupId,
  });
  const {
    apiNodes, setApiNodes,
    breakpoints, setBreakpoints,
    startNodeIds, setStartNodeIds,
    groups, setGroups,
    caseSets, setCaseSets,
    flowName, setFlowName,
    flowDescription, setFlowDescription,
    flowTags, setFlowTags,
    mutators: {
      patchApiNode, toggleBreakpoint, toggleStartNode, deleteNode,
      createEmptyGroupAt, createGroupFromSelection, deleteGroup, updateGroup, deleteEdge,
      onAutoLayout,
    },
    onSave,
  } = model;

  // ─── Undo/redo ─────────────────────────────────────────────────────────
  // Memoise the snapshot so the history hook's effect only re-runs when one of the
  // tracked fields actually changes — without this, every parent render produced a fresh
  // object reference and the hook tried to push on every tick (Max update depth).
  const currentSnapshot = useMemo<ScenarioSnapshot>(() => ({
    apiNodes, breakpoints, startNodeIds, groups, caseSets,
    flowName, flowDescription, flowTags,
  }), [apiNodes, breakpoints, startNodeIds, groups, caseSets,
       flowName, flowDescription, flowTags]);
  const applySnapshot = useCallback((snap: ScenarioSnapshot) => {
    setApiNodes(snap.apiNodes);
    setBreakpoints(snap.breakpoints);
    setStartNodeIds(snap.startNodeIds);
    setGroups(snap.groups);
    setCaseSets(snap.caseSets);
    setFlowName(snap.flowName);
    setFlowDescription(snap.flowDescription);
    setFlowTags(snap.flowTags);
  }, [setApiNodes, setBreakpoints, setStartNodeIds, setGroups, setCaseSets,
      setFlowName, setFlowDescription, setFlowTags]);
  const history = useScenarioHistory({
    current: currentSnapshot,
    apply: applySnapshot,
  });

  // Clipboard buffer for canvas-scoped copy/cut/paste. Stores plain ApiNode snapshots —
  // never touches the OS clipboard, so it doesn't fight with text-input copy/paste.
  const clipboardRef = useRef<ApiNode[]>([]);

  // Cmd+Z / Ctrl+Z undo, Cmd+Shift+Z / Ctrl+Y redo, Cmd/Ctrl+C/X/V/D for selection
  // copy / cut / paste / duplicate. Skip when focus is inside a text entry control so
  // native input shortcuts (and the undo buffer) keep working there.
  useEffect(() => {
    function isInsideInput(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }
    function clipboardCopy(): void {
      const ids = selectedIds.length > 0 ? selectedIds : (selectedNodeId ? [selectedNodeId] : []);
      if (ids.length === 0) return;
      const snap = apiNodes.filter((n) => ids.includes(n.id));
      if (snap.length === 0) return;
      clipboardRef.current = snap.map((n) => JSON.parse(JSON.stringify(n)));
    }
    function clipboardPaste(offsetX = 40, offsetY = 40): void {
      if (clipboardRef.current.length === 0) return;
      const existing = nodes;
      const clones: ApiNode[] = [];
      const rfClones: RFNode[] = [];
      for (const src of clipboardRef.current) {
        const newId = nextNodeId(existing.concat(rfClones), src.method, src.path);
        const cloned: ApiNode = {
          ...src,
          id: newId,
          position: src.position
            ? { x: src.position.x + offsetX, y: src.position.y + offsetY }
            : { x: offsetX, y: offsetY },
        };
        clones.push(cloned);
        rfClones.push({
          id: newId,
          type: 'api',
          position: cloned.position!,
          data: { label: newId, method: src.method.toUpperCase(), path: src.path, status: 'pending', idle: true },
        });
      }
      setApiNodes((cur) => [...cur, ...clones]);
      setNodes((cur) => [...cur, ...rfClones]);
      setDirty(true);
      // Select the freshly-pasted nodes so next paste cascades correctly.
      const pastedIds = clones.map((n) => n.id);
      setSelectedNodeId(pastedIds[pastedIds.length - 1] ?? null);
      setSelectedIds(pastedIds);
    }
    function clipboardCut(): void {
      const ids = selectedIds.length > 0 ? selectedIds : (selectedNodeId ? [selectedNodeId] : []);
      if (ids.length === 0) return;
      clipboardCopy();
      for (const id of ids) deleteNode(id);
    }
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (isInsideInput(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        history.redo();
      } else if (key === 'c') {
        e.preventDefault();
        clipboardCopy();
      } else if (key === 'x') {
        e.preventDefault();
        clipboardCut();
      } else if (key === 'v') {
        e.preventDefault();
        clipboardPaste();
      } else if (key === 'd') {
        // Duplicate — copy then paste in one shot, no clipboard mutation.
        e.preventDefault();
        const saved = clipboardRef.current;
        clipboardCopy();
        clipboardPaste(40, 40);
        clipboardRef.current = saved;
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, selectedIds, selectedNodeId, apiNodes, nodes]);

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
    setHistoricalRunId(null);
    runExec.reset();
    history.reset({
      apiNodes: scenario.nodes,
      breakpoints: scenario.breakpoints ?? [],
      startNodeIds: scenario.startNodeIds ?? [],
      groups: scenario.groups ?? [],
      caseSets: scenario.caseSets ?? [],
      flowName: scenario.name,
      flowDescription: scenario.description ?? '',
      flowTags: scenario.tags ?? [],
    });
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

  // Note: an earlier iteration repositioned api nodes during a run to avoid response
  // balloons overlapping. That trampled the user's manual layout, so the spread was
  // removed — node positions stay exactly where the user put them, and the balloon
  // alternation (right / left / right / left via balloonSide) is the only positioning
  // hint we apply.

  const selectedApiNode = apiNodes.find((n) => n.id === selectedNodeId) ?? null;


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
      // First node in an empty canvas → auto-mark as start so the engine's run-from-start
      // path picks it up without the user toggling the right-click menu.
      const isFirstApiNode = !apiNodes.some((n) => n.id !== id);
      setApiNodes((cur) => [...cur, seeded]);
      if (isFirstApiNode) {
        setStartNodeIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
      }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, apiNodes, screenToFlowPosition, setNodes, setEdges, setApiNodes, setStartNodeIds]
  );


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
  // Bind bridges so the run-execution callback and scenario-model mutators (defined
  // earlier in the function body) reach the live dirtyTracking setters at call time.
  dirtyRefBridge.current = dirtyRef;
  saveRefBridge.current = onSaveRef.current;
  // In historical view dirty-flag flips become no-ops so edits don't trigger autosave
  // and the user can still browse without accidentally persisting changes.
  dirtyBridge.current = historicalRunId ? (() => {}) : setDirty;
  savingBridge.current = setSaving;
  lastSavedAtBridge.current = setLastSavedAt;
  const nowTick = useVisibilityTicker(lastSavedAt != null);


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
      {running && sseStatus === 'reconnecting' && (
        <div className="sse-reconnect-banner" role="status" aria-live="polite">
          Reconnecting to live run stream…
        </div>
      )}
      {historicalRunId && (
        <div className="history-banner" role="status" aria-live="polite">
          <span className="history-banner-icon" aria-hidden="true">👁</span>
          <span>Viewing run <code>{historicalRunId.slice(0, 8)}</code> · read-only</span>
          <button
            type="button"
            className="history-banner-exit"
            onClick={() => { setRun(null); setHistoricalRunId(null); }}
          >✕ Exit history view</button>
        </div>
      )}
      <div className="canvas-toolbar">
        <button
          className="btn primary"
          onClick={() => { setHistoricalRunId(null); void onStart(); }}
          disabled={running || saving}
        >
          {running ? '● running…' : '▶ Run'}
        </button>
        <button className="btn" onClick={onAutoLayout}>⌘ Layout</button>
        <button
          className="btn"
          onClick={history.undo}
          disabled={!history.canUndo}
          title="Undo (⌘Z)"
        >↶ Undo</button>
        <button
          className="btn"
          onClick={history.redo}
          disabled={!history.canRedo}
          title="Redo (⌘⇧Z)"
        >↷ Redo</button>
        <TopnavSlot>
          <SaveStatus
            dirty={dirty}
            saving={saving}
            err={err}
            lastSavedAt={lastSavedAt}
            nowTick={nowTick}
            onForceSave={onSave}
          />
          <RunHistoryToggle />
        </TopnavSlot>
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
      {selectedIds.length > 1 && (
        <div className="selection-bar">
          <span>{selectedIds.length} nodes selected</span>
          {!groups.some((g) => g.nodeIds.some((nid) => selectedIds.includes(nid))) && (
            <button className="btn primary" onClick={createGroupFromSelection}>⊞ Create group</button>
          )}
          <button className="btn" onClick={() => setBulkEditOpen(true)}>✎ Bulk edit</button>
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
      {bulkEditOpen && (
        <BulkEditModal
          selectedIds={selectedIds}
          apiNodes={apiNodes}
          onApply={(patches) => {
            // Group patches by nodeId and merge with the existing field map.
            const byNode = new Map<string, typeof patches>();
            for (const p of patches) {
              const arr = byNode.get(p.nodeId) ?? [];
              arr.push(p);
              byNode.set(p.nodeId, arr);
            }
            for (const [nodeId, ps] of byNode) {
              const target = apiNodes.find((n) => n.id === nodeId);
              if (!target) continue;
              const next: Partial<ApiNode> = {};
              for (const p of ps) {
                const fieldKey = p.field === 'header' ? 'headers'
                  : p.field === 'queryParameter' ? 'queryParameters'
                  : 'pathParameters';
                const current = (next[fieldKey] ?? target[fieldKey] ?? {}) as Record<string, unknown>;
                next[fieldKey] = { ...current, [p.key]: p.value };
              }
              patchApiNode(nodeId, next);
            }
          }}
          onClose={() => setBulkEditOpen(false)}
        />
      )}
      {detailModalOpen && (
        <ScenarioDetailModal
          name={flowName}
          description={flowDescription}
          tags={flowTags}
          onNameChange={(v) => { setFlowName(v); setDirty(true); }}
          onDescriptionChange={(v) => { setFlowDescription(v); setDirty(true); }}
          onTagsChange={(v) => { setFlowTags(v); setDirty(true); }}
          onClose={() => setDetailModalOpen(false)}
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
            onNodeDoubleClick={(_e, n) => {
              // Double-click on the currently paused node = resume the breakpoint without
              // opening the right-click menu. Only acts when the run is actually paused at
              // this node, so accidental double-clicks elsewhere are no-ops.
              if (isStructuralRf(n)) return;
              const cloned = parseBranchCloneRf(n.id);
              const canonicalId = cloned ? cloned.nodeId : n.id;
              if (run?.status === 'paused' && run.pausedAtNodeId === canonicalId) {
                void onResolveBreakpoint('resume');
              }
            }}
            onPaneClick={() => setSelectedNodeId(null)}
            onSelectionChange={({ nodes: sel }) => {
              const nextIds = sel.filter(isApiRf).map((n) => n.id);
              setSelectedIds((cur) => {
                if (cur.length === nextIds.length && cur.every((id, i) => id === nextIds[i])) return cur;
                return nextIds;
              });
              const gnode = sel.find(isGroupRfNode);
              const nextGid = gnode ? groupIdFromRf(gnode.id) : null;
              setSelectedGroupId((cur) => (cur === nextGid ? cur : nextGid));
            }}
            onPaneContextMenu={contextMenus.paneHandler}
            onNodeContextMenu={contextMenus.nodeHandler}
            onEdgeContextMenu={contextMenus.edgeHandler}
            fitView
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
            /* Hold any of these to drag a marquee selection instead of panning. */
            selectionKeyCode={['Shift', 'Meta', 'Control']}
            /* Multi-select on click stays bound to Shift only — Ctrl/Cmd would swallow
               native keyboard shortcuts (copy/cut/etc) the user expects on the canvas. */
            multiSelectionKeyCode="Shift"
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
          onUpdateGroup={(next) => updateGroup(next)}
          onDeleteGroup={(gid) => deleteGroup(gid)}
          onCaseSetChange={(anchorId, next) => {
            setDirty(true);
            setCaseSets((cur) => {
              const others = cur.filter((c) => c.anchorNodeId !== anchorId);
              return next ? [...others, next] : others;
            });
          }}
        />
      </div>
      <RunHistoryDrawer
        scenarioId={scenario.id}
        refreshTick={historyTick}
        activeRunId={historicalRunId}
        activeRun={historicalRunId ? run : null}
        onPickNode={(nodeId) => setSelectedNodeId(nodeId)}
        onOpenDetail={() => setDetailModalOpen(true)}
        onOpenRun={(historical) => {
          // Drop any live SSE subscription so the historical load isn't clobbered by an
          // in-flight event from a different run.
          runExec.reset();
          setRun(historical);
          setHistoricalRunId(historical.id);
          setSelectedBranchKey(null);
          // Close the inspector — historical detail lives inline in the drawer, not in
          // the right-side panel. Avoids two competing surfaces fighting for attention.
          setSelectedNodeId(null);
        }}
      />
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

/** Portal mount that teleports children into App's #topnav-scenario-slot when present.
 *  Falls back to inline rendering if the slot isn't on the page (smoke tests, etc.). */
function TopnavSlot({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.getElementById('topnav-scenario-slot');
    setTarget(el);
  }, []);
  if (!target) return null;
  return createPortal(children, target);
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

function RunHistoryToggle() {
  const open = usePrefs((s) => s.runHistoryOpen);
  const set = usePrefs((s) => s.set);
  return (
    <button
      type="button"
      className={`btn run-history-toggle${open ? ' is-on' : ''}`}
      onClick={() => set('runHistoryOpen', !open)}
      title="Toggle run history drawer"
      aria-pressed={open}
    >
      <span className="run-history-toggle-switch" aria-hidden="true">
        <span className="run-history-toggle-knob" />
      </span>
      <span>History</span>
    </button>
  );
}

interface RunHistoryDrawerProps {
  scenarioId: string;
  refreshTick: number;
  onOpenRun?: (run: import('./api').Run) => void;
  activeRunId?: string | null;
  activeRun?: import('./api').Run | null;
  onPickNode?: (nodeId: string) => void;
  onOpenDetail?: () => void;
}

function RunHistoryDrawer({ scenarioId, refreshTick, onOpenRun, activeRunId, activeRun, onPickNode, onOpenDetail }: RunHistoryDrawerProps) {
  const open = usePrefs((s) => s.runHistoryOpen);
  const set = usePrefs((s) => s.set);
  return createPortal(
    <aside
      className={`run-history-drawer${open ? ' is-open' : ''}`}
      aria-hidden={!open}
      aria-label="Run history"
    >
      <header className="run-history-drawer-head">
        <span className="run-history-drawer-title">Run history</span>
        <div className="run-history-drawer-actions">
          {onOpenDetail && (
            <button
              type="button"
              className="run-history-drawer-detail"
              onClick={onOpenDetail}
              title="Edit scenario name, description and tags"
            >Detail</button>
          )}
          <button
            type="button"
            className="run-history-drawer-close"
            onClick={() => set('runHistoryOpen', false)}
            aria-label="Close history"
          >×</button>
        </div>
      </header>
      <div className="run-history-drawer-body">
        {open && (
          <RunHistoryPanel
            scenarioId={scenarioId}
            refreshTick={refreshTick}
            onOpenRun={onOpenRun}
            activeRunId={activeRunId}
            activeRun={activeRun}
            onPickNode={onPickNode}
          />
        )}
      </div>
    </aside>,
    document.body,
  );
}

