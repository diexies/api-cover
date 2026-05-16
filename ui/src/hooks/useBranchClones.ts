import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import {
  branchKey,
  type ApiNode,
  type CaseSet,
  type ExecutionGroup,
  type Run,
} from '../api';
import {
  BRANCH_LANE_SPREAD,
  branchCloneEdgeId,
  branchCloneRfId,
  isApiRf,
  isBranchCloneEdge,
  isBranchCloneRf,
} from '../canvas/scenarioCanvasUtils';

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

  return { branchKeys, branchLabelFor };
}
