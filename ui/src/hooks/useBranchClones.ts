import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import {
  branchKey,
  type ApiNode,
  type CaseSet,
  type ExecutionGroup,
  type Run,
} from '../api';
import { isApiRf, isBranchCloneEdge } from '../canvas/scenarioCanvasUtils';
import {
  buildCloneEdges,
  buildCloneNodes,
  planBranchFanOut,
  reconcileCloneEdges,
  reconcileCloneNodes,
} from '../canvas/branchClones';

export interface UseBranchClonesArgs {
  run: Run | null;
  groups: ExecutionGroup[];
  caseSets: CaseSet[];
  apiNodes: ApiNode[];
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  selectedBranchKey: string | null;
  setSelectedBranchKey: (v: string | null) => void;
}

export interface UseBranchClonesReturn {
  branchKeys: string[];
  branchLabelFor: (key: string) => string;
}

/**
 * Spawns synthetic RF nodes for each (in-group node × branch) so the canvas literally shows
 * each iteration as its own copy. Originals are hidden while branches exist; cleared back
 * when run is reset. Edges are re-routed: upstream → each branch's first node, branch lanes
 * sequential, last → downstream.
 *
 * Behavioural invariants preserved:
 * - Two `setNodes` calls + one `setEdges` are sequenced deliberately; the edge rewrite
 *   reads the `inBranchOriginals` set computed locally. DO NOT combine into one updater.
 * - The inline branch label resolution inside the clone-build loop is deliberately
 *   duplicated against `branchLabelFor` so the clone effect doesn't capture the hook's
 *   closure — see the original comment at L317-318.
 * - Idempotency guards (`cloneSetChanged`, `hiddenChanged`) prevent infinite render loops
 *   with React Flow's internal `useNodesState`.
 */
export function useBranchClones({
  run,
  groups,
  caseSets,
  apiNodes,
  setNodes,
  setEdges,
  selectedBranchKey,
  setSelectedBranchKey,
}: UseBranchClonesArgs): UseBranchClonesReturn {
  // Branch keys present in the current run (excluding root). Drives the picker chip row.
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
  }, [branchKeys, selectedBranchKey, setSelectedBranchKey]);

  // Branch fan-out: spawn synthetic RF nodes for each (in-group node × branch) so the
  // playground literally shows each iteration as its own copy of the API. Originals are
  // hidden while branches exist; cleared back when run is reset. Edges are re-routed.
  //
  // Two setState calls run sequentially (nodes then edges) — deliberate, edge reconcile
  // reads inBranchOriginals which is plain data, not RF state. RF batches them safely.
  useEffect(() => {
    const plan = planBranchFanOut(run, groups);
    setNodes((cur) => {
      const apiRf = cur.filter(isApiRf);
      const desired = buildCloneNodes(apiRf, plan, groups);
      return reconcileCloneNodes(cur, desired, plan.inBranchOriginals);
    });
    setEdges((cur) => {
      const orig = cur.filter((e) => !isBranchCloneEdge(e));
      const desired = buildCloneEdges(orig, plan);
      return reconcileCloneEdges(cur, desired, plan.inBranchOriginals);
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

  return { branchKeys, branchLabelFor };
}
