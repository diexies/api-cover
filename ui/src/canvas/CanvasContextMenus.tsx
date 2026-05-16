import { useCallback, useState } from 'react';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { ApiNodeData } from '../ApiNodeView';
import {
  aggregateNodeResult,
  getNodeResult,
  type Breakpoint,
  type CaseSet,
  type EndpointDescriptor,
  type ExecutionGroup,
  type Run,
  getRun,
} from '../api';
import { groupIdFromRf, isGroupRfNode, parseBranchCloneRf } from './scenarioCanvasUtils';
import { normalisePath } from '../App';

type Menu = { x: number; y: number; items: MenuItem[] } | null;

export interface CanvasContextMenuActions {
  onStart: () => void;
  onAutoLayout: () => void;
  createEmptyGroupAt: (x: number, y: number) => void;
  setEditingGroupId: (gid: string | null) => void;
  deleteGroup: (gid: string) => void;
  toggleBreakpoint: (nodeId: string) => void;
  toggleStartNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  createGroupFromSelection: () => void;
  updateGroup: (next: ExecutionGroup) => void;
  setSelectedNodeId: (id: string | null) => void;
  setQuickCallEp: (ep: EndpointDescriptor | null) => void;
  setCaseSets: (updater: (cur: CaseSet[]) => CaseSet[]) => void;
  setDirty: (v: boolean) => void;
  setRun: (run: Run | null) => void;
  setErr: (msg: string | null) => void;
  onResolveBreakpoint: (action: 'resume' | 'skip' | 'abort') => Promise<void>;
  deleteEdge: (edgeId: string) => void;
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
}

export interface CanvasContextMenuState {
  running: boolean;
  saving: boolean;
  run: Run | null;
  breakpoints: Breakpoint[];
  startNodeIds: string[];
  groups: ExecutionGroup[];
  caseSets: CaseSet[];
  selectedIds: string[];
  endpointLookup: Map<string, EndpointDescriptor>;
}

export interface UseCanvasContextMenusResult {
  paneHandler: (e: React.MouseEvent | MouseEvent) => void;
  nodeHandler: (e: React.MouseEvent, node: RFNode) => void;
  edgeHandler: (e: React.MouseEvent, edge: RFEdge) => void;
  menuElement: React.ReactNode;
}

/**
 * Owns the right-click context-menu state and renders the floating ContextMenu element.
 * Returns three React-Flow event handlers plus a ready-to-mount JSX element. The original
 * inline implementation used three useCallback dep arrays with `react-hooks/exhaustive-deps`
 * disabled — those overrides are preserved here verbatim because the deps are deliberately
 * under-specified to avoid handler identity churn.
 */
export function useCanvasContextMenus(
  state: CanvasContextMenuState,
  actions: CanvasContextMenuActions,
): UseCanvasContextMenusResult {
  const [menu, setMenu] = useState<Menu>(null);
  const {
    running,
    saving,
    run,
    breakpoints,
    startNodeIds,
    groups,
    selectedIds,
    caseSets,
    endpointLookup,
  } = state;
  const {
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
  } = actions;

  const paneHandler = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      if ('ctrlKey' in e && (e as MouseEvent).ctrlKey) return;
      const me = e as MouseEvent;
      setMenu({
        x: me.clientX,
        y: me.clientY,
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
    [running, saving, run, screenToFlowPosition],
  );

  const nodeHandler = useCallback(
    (e: React.MouseEvent, node: RFNode) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      // Group area right-click → group menu, not the api-node menu.
      if (isGroupRfNode(node)) {
        const gid = groupIdFromRf(node.id);
        const grp = groups.find((g) => g.id === gid);
        if (grp) {
          setMenu({
            x: e.clientX,
            y: e.clientY,
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
      // Groups this node could be added to (not the one it's already in). The geometric
      // membership rule (centre-inside-bounds) is bypassed here — explicit add wins over
      // geometry, mirroring how "Remove from group" overrides containment.
      const otherGroups = groups.filter((g) => !g.nodeIds.includes(canonicalId));
      const addToGroupItems: MenuItem[] = otherGroups.length > 0
        ? [
            { separator: true },
            { label: 'Add to group:', header: true },
            ...otherGroups.map<MenuItem>((g) => ({
              label: `⊞ ${g.label ?? g.id}`,
              onClick: () => updateGroup({
                ...g,
                nodeIds: [...g.nodeIds, canonicalId],
              }),
            })),
          ]
        : [];

      const itemsForGroupAware: MenuItem[] = myGroup
        ? [
            { separator: true },
            { label: `Group: ${myGroup.label ?? myGroup.id}`, header: true },
            { label: '⚙ Group settings…', onClick: () => setEditingGroupId(myGroup.id) },
            {
              label: '✕ Remove from group',
              onClick: () => {
                const nextNodes = myGroup.nodeIds.filter((x) => x !== node.id);
                if (nextNodes.length === 0) deleteGroup(myGroup.id);
                else updateGroup({
                  ...myGroup,
                  nodeIds: nextNodes,
                  mutations: myGroup.mutations?.filter((m) => m.nodeId !== node.id),
                });
              },
            },
            ...addToGroupItems,
          ]
        : (selectedIds.length > 1 && selectedIds.includes(node.id))
          ? [
              { separator: true },
              { label: `${selectedIds.length} nodes selected`, header: true },
              { label: '⊞ Create group from selection', onClick: createGroupFromSelection },
              ...addToGroupItems,
            ]
          : addToGroupItems;

      const epForNode = endpointLookup.get(`${data.method.toUpperCase()} ${normalisePath(data.path)}`);
      setMenu({
        x: e.clientX,
        y: e.clientY,
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
          { label: 'Skip', onClick: () => onResolveBreakpoint('skip'), disabled: !isPaused },
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
    [run, breakpoints, startNodeIds, groups, selectedIds, caseSets],
  );

  const edgeHandler = useCallback(
    (e: React.MouseEvent, edge: RFEdge) => {
      e.preventDefault();
      if (e.ctrlKey) return;
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: `Edge: ${edge.source} → ${edge.target}`, header: true },
          { label: '🗑 Delete edge', danger: true, onClick: () => deleteEdge(edge.id) },
        ],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const menuElement = menu
    ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
    : null;

  return { paneHandler, nodeHandler, edgeHandler, menuElement };
}
