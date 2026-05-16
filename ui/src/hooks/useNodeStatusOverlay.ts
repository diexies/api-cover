import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import {
  aggregateNodeResult,
  getNodeResult,
  type Breakpoint,
  type CaseSet,
  type ExecutionGroup,
  type NodeResult,
  type NodeStatus,
  type Run,
} from '../api';
import {
  groupHashClass,
  isStructuralRf,
  parseBranchCloneRf,
} from '../canvas/scenarioCanvasUtils';

export interface UseNodeStatusOverlayArgs {
  run: Run | null;
  breakpoints: Breakpoint[];
  groups: ExecutionGroup[];
  caseSets: CaseSet[];
  startNodeIds: string[];
  selectedBranchKey: string | null;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
}

/**
 * Reads run status + scenario shape and overlays per-node status / per-edge animation
 * onto the live ReactFlow state. Pure read-side: never sets scenario state, only writes
 * back into RF nodes/edges.
 *
 * Ordering note: callers must invoke `useBranchClones` BEFORE this hook so clone nodes
 * exist when the overlay runs. The original inline implementation had the clone effect
 * declared earlier in the function body, and React respects effect mount order.
 */
export function useNodeStatusOverlay({
  run,
  breakpoints,
  groups,
  caseSets,
  startNodeIds,
  selectedBranchKey,
  setNodes,
  setEdges,
}: UseNodeStatusOverlayArgs): void {
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
      }),
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
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, breakpoints, groups, caseSets, startNodeIds, selectedBranchKey]);
}
