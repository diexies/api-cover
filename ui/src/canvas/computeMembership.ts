import type { ExecutionGroup } from '../api';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApiNodeSample {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GroupSample {
  id: string;
  bounds: Rect;
}

export interface MembershipInput {
  /** API nodes on the canvas with current position + measured size. */
  apiNodes: ApiNodeSample[];
  /** Group area nodes with current bounds. */
  groupSamples: GroupSample[];
  /** Current scenario groups (source of truth for nodeIds + persistence). */
  groups: ExecutionGroup[];
  /** Previous-frame snapshot keyed by API node id, used to skip recomputes when nothing moved. */
  prevPositions: Map<string, Rect>;
  /** Previous-frame snapshot of group bounds, used to detect group resizes. */
  prevGroupBounds: Map<string, Rect>;
}

export interface MembershipOutput {
  /** New groups array — reference-equal to input when no membership/bounds changed. */
  groups: ExecutionGroup[];
  /** Updated position cache for the next frame. */
  nextPositions: Map<string, Rect>;
  /** Updated group bounds cache for the next frame. */
  nextGroupBounds: Map<string, Rect>;
}

function rectEq(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

function unionRect(rs: Rect[]): Rect | null {
  if (rs.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rs) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function containsCentre(group: Rect, n: ApiNodeSample): boolean {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height;
}

function setEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const id of b) if (!s.has(id)) return false;
  return true;
}

/**
 * Pure membership recompute. Skips work when no API node has moved/resized and no group
 * bounds changed — returns the input groups reference unchanged. Otherwise rebuilds the
 * affected groups' nodeIds via spatial containment.
 */
export function computeMembership(input: MembershipInput): MembershipOutput {
  const { apiNodes, groupSamples, groups, prevPositions, prevGroupBounds } = input;

  const groupBoundsById = new Map<string, Rect>();
  for (const g of groupSamples) groupBoundsById.set(g.id, g.bounds);

  // Drop groups whose RF node is gone (deleted from canvas) but keep groups awaiting bounds.
  const survivingGroups = groups.filter((g) => groupBoundsById.has(g.id) || !g.bounds);

  // Diff: which API nodes changed position or size since last frame
  const changedNodes: ApiNodeSample[] = [];
  const nextPositions = new Map<string, Rect>();
  for (const n of apiNodes) {
    const rect: Rect = { x: n.x, y: n.y, width: n.w, height: n.h };
    nextPositions.set(n.id, rect);
    const prev = prevPositions.get(n.id);
    if (!rectEq(prev, rect)) changedNodes.push(n);
  }
  // Also: any node present last frame but missing now (deleted) → drop from caches by not copying.

  // Diff: which groups changed bounds (or are newly present)
  const changedGroupIds = new Set<string>();
  const nextGroupBounds = new Map<string, Rect>();
  for (const g of groupSamples) {
    nextGroupBounds.set(g.id, g.bounds);
    if (!rectEq(prevGroupBounds.get(g.id), g.bounds)) changedGroupIds.add(g.id);
  }
  // Any group whose bounds vanished is already covered by survivingGroups filter above.

  // Fast path: nothing moved or resized → return input groups untouched.
  // Still update caches via the maps we built so the next call has the latest snapshot.
  if (changedNodes.length === 0 && changedGroupIds.size === 0 && survivingGroups.length === groups.length) {
    return { groups, nextPositions, nextGroupBounds };
  }

  // Union of (old + new) rects of every changed node — limits which groups need recompute.
  const dirtyRects: Rect[] = [];
  for (const n of changedNodes) {
    const prev = prevPositions.get(n.id);
    if (prev) dirtyRects.push(prev);
    dirtyRects.push({ x: n.x, y: n.y, width: n.w, height: n.h });
  }
  const dirtyBbox = unionRect(dirtyRects);

  let mutated = survivingGroups.length !== groups.length;
  const next: ExecutionGroup[] = survivingGroups.map((g) => {
    const bounds = groupBoundsById.get(g.id);
    if (!bounds) return g;

    const groupChanged = changedGroupIds.has(g.id);
    const intersectsDirty = dirtyBbox ? rectsIntersect(bounds, dirtyBbox) : false;
    if (!groupChanged && !intersectsDirty) {
      // No node near this group moved and bounds unchanged — keep as-is, but refresh
      // bounds reference if it was previously undefined (newly-bound case).
      if (rectEq(g.bounds, bounds)) return g;
      mutated = true;
      return { ...g, bounds };
    }

    const memberIds = apiNodes.filter((n) => containsCentre(bounds, n)).map((n) => n.id);
    const sameBounds = rectEq(g.bounds, bounds);
    const sameMembers = setEq(g.nodeIds, memberIds);
    if (sameBounds && sameMembers) return g;
    mutated = true;
    return { ...g, bounds, nodeIds: memberIds };
  });

  return {
    groups: mutated ? next : groups,
    nextPositions,
    nextGroupBounds,
  };
}
