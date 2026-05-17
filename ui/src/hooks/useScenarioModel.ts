import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import type { GroupAreaData } from '../GroupAreaNode';
import {
  saveScenario,
  type ApiNode,
  type Breakpoint,
  type CaseSet,
  type ExecutionGroup,
  type Scenario,
} from '../api';
import { autoLayout } from '../layout';
import {
  NEW_NODE_H,
  NEW_NODE_W,
  colorForGroup,
  groupIdFromRf,
  groupRfId,
  isApiRf,
  isBranchCloneEdge,
  isGroupRfNode,
} from '../canvas/scenarioCanvasUtils';

export interface UseScenarioModelArgs {
  scenario: Scenario;
  /** Live RF state — read by mutators to keep visual + canonical state in sync. */
  nodes: RFNode[];
  edges: RFEdge[];
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  /** Late-bound dirty-flag setter (useDirtyTracking is declared AFTER this hook, so we
   *  resolve it through a ref at call time). The mutators read `dirtyBridge.current(true)`. */
  dirtyBridge: React.MutableRefObject<(v: boolean) => void>;
  savingBridge: React.MutableRefObject<(v: boolean) => void>;
  lastSavedAtBridge: React.MutableRefObject<(v: number | null) => void>;
  setErr: (msg: string | null) => void;
  /** Callback fired with the persisted scenario after a successful save. */
  onSaved: (next: Scenario) => void;
  /** Imperative escape hatch for the right-click "Remove from group" handler when the
   *  caller needs to nullify the selectedNodeId pointer post-delete. */
  selectedNodeIdRef: React.MutableRefObject<string | null>;
  setSelectedNodeId: (v: string | null) => void;
  /** Selected ids for "Create group from selection" — read at call time. */
  selectedIdsRef: React.MutableRefObject<string[]>;
  setEditingGroupId: (v: string | null) => void;
}

export interface UseScenarioModelReturn {
  apiNodes: ApiNode[];
  setApiNodes: Dispatch<SetStateAction<ApiNode[]>>;
  breakpoints: Breakpoint[];
  setBreakpoints: Dispatch<SetStateAction<Breakpoint[]>>;
  startNodeIds: string[];
  setStartNodeIds: Dispatch<SetStateAction<string[]>>;
  groups: ExecutionGroup[];
  setGroups: Dispatch<SetStateAction<ExecutionGroup[]>>;
  caseSets: CaseSet[];
  setCaseSets: Dispatch<SetStateAction<CaseSet[]>>;
  flowName: string;
  setFlowName: Dispatch<SetStateAction<string>>;
  flowDescription: string;
  setFlowDescription: Dispatch<SetStateAction<string>>;
  flowTags: string[];
  setFlowTags: Dispatch<SetStateAction<string[]>>;
  mutators: {
    patchApiNode: (id: string, patch: Partial<ApiNode>) => void;
    toggleBreakpoint: (nodeId: string) => void;
    toggleStartNode: (nodeId: string) => void;
    deleteNode: (nodeId: string) => void;
    createEmptyGroupAt: (canvasX: number, canvasY: number) => void;
    createGroupFromSelection: () => void;
    deleteGroup: (groupId: string) => void;
    updateGroup: (next: ExecutionGroup) => void;
    deleteEdge: (edgeId: string) => void;
    onAutoLayout: () => void;
  };
  onSave: () => Promise<void>;
}

/**
 * Owns the authoritative scenario state (apiNodes, breakpoints, startNodeIds, groups,
 * caseSets, flowName/Description/Tags) plus every mutator and the persistence merge
 * (`onSave`). Reads RF visual state to keep both sides in sync.
 *
 * Behavioural invariants preserved:
 * - `setDirty(true)` after every mutator — 10+ call-sites in the original; reproduced here.
 * - `onSave` resolves geometric group membership from the LIVE RF state and writes
 *   `setGroups(resolvedGroups)` BEFORE awaiting `saveScenario`. Keeps the UI ring visible
 *   during the network round-trip.
 * - `onSave` strips `isBranchCloneEdge` edges before persisting; only canonical edges
 *   round-trip through the backend.
 * - `onSave` snapshots RF node positions back into `ApiNode.position` via `rfPosById` so
 *   they survive reload.
 * - `onAutoLayout` only touches RF nodes, not `apiNodes` — positions sync lazily inside
 *   `onSave` via the same `rfPosById` map.
 */
export function useScenarioModel(args: UseScenarioModelArgs): UseScenarioModelReturn {
  const {
    scenario, nodes, edges, setNodes, setEdges,
    dirtyBridge, savingBridge, lastSavedAtBridge, setErr, onSaved,
    selectedNodeIdRef, setSelectedNodeId,
    selectedIdsRef, setEditingGroupId,
  } = args;

  const setDirty = (v: boolean) => dirtyBridge.current(v);
  const setSaving = (v: boolean) => savingBridge.current(v);
  const setLastSavedAt = (v: number | null) => lastSavedAtBridge.current(v);

  // Authoritative scenario state (full ApiNode data) — RF state is just the visual mirror.
  const [apiNodes, setApiNodes] = useState<ApiNode[]>(scenario.nodes);
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>(scenario.breakpoints ?? []);
  const [startNodeIds, setStartNodeIds] = useState<string[]>(scenario.startNodeIds ?? []);
  const [groups, setGroups] = useState<ExecutionGroup[]>(scenario.groups ?? []);
  const [caseSets, setCaseSets] = useState<CaseSet[]>(scenario.caseSets ?? []);
  const [flowName, setFlowName] = useState<string>(scenario.name);
  const [flowDescription, setFlowDescription] = useState<string>(scenario.description ?? '');
  const [flowTags, setFlowTags] = useState<string[]>(scenario.tags ?? []);

  const patchApiNode = useCallback((id: string, patch: Partial<ApiNode>) => {
    setApiNodes((cur) => cur.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    setDirty(true);
  }, [setDirty]);

  const toggleBreakpoint = useCallback((nodeId: string) => {
    setBreakpoints((cur) => {
      const found = cur.find((b) => b.nodeId === nodeId);
      if (found) return cur.filter((b) => b.nodeId !== nodeId);
      return [...cur, { nodeId, enabled: true }];
    });
    setDirty(true);
  }, [setDirty]);

  const toggleStartNode = useCallback((nodeId: string) => {
    setStartNodeIds((cur) => (cur.includes(nodeId) ? cur.filter((x) => x !== nodeId) : [...cur, nodeId]));
    setDirty(true);
  }, [setDirty]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((cur) => cur.filter((n) => n.id !== nodeId));
    setEdges((cur) => cur.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setApiNodes((cur) => cur.filter((n) => n.id !== nodeId));
    setBreakpoints((cur) => cur.filter((b) => b.nodeId !== nodeId));
    setStartNodeIds((cur) => cur.filter((x) => x !== nodeId));
    setGroups((cur) => cur
      .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((x) => x !== nodeId), mutations: g.mutations?.filter((m) => m.nodeId !== nodeId) }))
      .filter((g) => g.nodeIds.length > 0));
    if (selectedNodeIdRef.current === nodeId) setSelectedNodeId(null);
    setDirty(true);
  }, [setNodes, setEdges, setDirty, selectedNodeIdRef, setSelectedNodeId]);

  const createEmptyGroupAt = useCallback((canvasX: number, canvasY: number) => {
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
  }, [setNodes, setDirty, setEditingGroupId]);

  const createGroupFromSelection = useCallback(() => {
    const selectedIds = selectedIdsRef.current;
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
  }, [nodes, setNodes, setDirty, selectedIdsRef, setEditingGroupId]);

  const deleteGroup = useCallback((groupId: string) => {
    setGroups((cur) => cur.filter((g) => g.id !== groupId));
    setNodes((cur) => cur.filter((n) => !(isGroupRfNode(n) && groupIdFromRf(n.id) === groupId)));
    setDirty(true);
  }, [setNodes, setDirty]);

  const updateGroup = useCallback((next: ExecutionGroup) => {
    setGroups((cur) => cur.map((g) => (g.id === next.id ? next : g)));
    setNodes((cur) => cur.map((n) =>
      isGroupRfNode(n) && groupIdFromRf(n.id) === next.id
        ? { ...n, data: { ...(n.data as GroupAreaData), label: next.label ?? next.id, color: next.backgroundColor ?? colorForGroup(next.id), count: next.repeat?.count } }
        : n,
    ));
    setDirty(true);
  }, [setNodes, setDirty]);

  const deleteEdge = useCallback((edgeId: string) => {
    setEdges((cur) => cur.filter((e) => e.id !== edgeId));
    setDirty(true);
  }, [setEdges, setDirty]);

  const onAutoLayout = useCallback(() => {
    setNodes((cur) => autoLayout(cur, edges));
    setDirty(true);
  }, [setNodes, edges, setDirty]);

  const onSave = useCallback(async () => {
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

      // Snapshot RF positions back into ApiNode.position so they survive reload. Also
      // dedupe by id — legacy scenarios occasionally have duplicate ids that crash the
      // engine's BranchEstimator; collapsing on save heals them gradually.
      const rfPosById = new Map(apiRf.map((n) => [n.id, n.position] as const));
      const seen = new Set<string>();
      const nodesWithPos = apiNodes
        .filter((n) => seen.has(n.id) ? false : (seen.add(n.id), true))
        .map((n) => {
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
        edges: edges.filter((e) => !isBranchCloneEdge(e)).map((e) => ({ from: e.source, to: e.target, mode: 'sequential' as const })),
        breakpoints,
        startNodeIds,
        groups: resolvedGroups,
        caseSets,
      };
      // Snap geometric membership into state BEFORE awaiting persist so the UI ring
      // reflects what's about to be saved.
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
  }, [
    scenario, nodes, edges, apiNodes, breakpoints, startNodeIds, groups, caseSets,
    flowName, flowDescription, flowTags,
    setSaving, setErr, setLastSavedAt, setDirty, onSaved,
  ]);

  return {
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
  };
}
