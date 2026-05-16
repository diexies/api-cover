import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Node as RFNode } from '@xyflow/react';
import { type GroupAreaData } from '../GroupAreaNode';
import {
  groupIdFromRf,
  isApiRf,
  isGroupRfNode,
  NEW_NODE_H,
  NEW_NODE_W,
} from '../canvas/scenarioCanvasUtils';
import { computeMembership, type Rect as MembershipRect } from '../canvas/computeMembership';
import type { ExecutionGroup, Run } from '../api';

export interface UseGroupMembershipArgs {
  /** ReactFlow nodes array, including api + structural area nodes. */
  nodes: RFNode[];
  /** RF setter — used to write back iteration tally into group-area data. */
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  /** Source-of-truth groups setter (geometric membership recompute writes here). */
  setGroups: Dispatch<SetStateAction<ExecutionGroup[]>>;
  /** Current groups — read for the iteration tally tally. */
  groups: ExecutionGroup[];
  /** Latest run snapshot — drives the per-iteration counters on each group area. */
  run: Run | null;
}

/**
 * Two coupled effects:
 *
 * 1) Geometric membership recompute. When an api node's centre lands inside (or leaves)
 *    a group rectangle, the underlying ExecutionGroup.nodeIds list is updated. Memoised
 *    via a prev-position snapshot — when no api node moved and no group bounds changed,
 *    the helper returns the same `groups` reference and React bails on the setGroups call.
 *
 * 2) Iteration tally tally. For each group, derive `runningIter / totalIter / passed /
 *    failed / isRunning` from `run.nodeResults` whose branchPath segments match
 *    `<groupId>#<n>`. Writes back into the matching RF group-area `data` blob, idempotent
 *    via field-by-field equality so the effect doesn't churn.
 */
export function useGroupMembership({
  nodes,
  setNodes,
  setGroups,
  groups,
  run,
}: UseGroupMembershipArgs): void {
  // Snapshot of API node bounds and group bounds from the prior membership pass — lets the
  // memoised recompute below skip groups whose neighbourhood didn't move.
  const prevApiPositionsRef = useRef<Map<string, MembershipRect>>(new Map());
  const prevGroupBoundsRef = useRef<Map<string, MembershipRect>>(new Map());

  // Live geometric membership: recompute every group's nodeIds from current positions vs
  // current bounds. The setNodes((cur) => …) short-circuit returns `cur` when nothing
  // changed so no downstream effect re-fires.
  useEffect(() => {
    const apiNodes = nodes.filter(isApiRf).map((n) => ({
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: n.measured?.width ?? NEW_NODE_W,
      h: n.measured?.height ?? NEW_NODE_H,
    }));
    const groupSamples = nodes.filter(isGroupRfNode).map((rf) => {
      const id = groupIdFromRf(rf.id);
      return {
        id,
        bounds: {
          x: rf.position.x,
          y: rf.position.y,
          width: (rf.style?.width as number | undefined) ?? rf.measured?.width ?? 200,
          height: (rf.style?.height as number | undefined) ?? rf.measured?.height ?? 120,
        },
      };
    });
    setGroups((cur) => {
      const out = computeMembership({
        apiNodes,
        groupSamples,
        groups: cur,
        prevPositions: prevApiPositionsRef.current,
        prevGroupBounds: prevGroupBoundsRef.current,
      });
      prevApiPositionsRef.current = out.nextPositions;
      prevGroupBoundsRef.current = out.nextGroupBounds;
      return out.groups;
    });
  }, [nodes, setGroups]);

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
}
