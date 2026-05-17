import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';
import { ApiNodeView, type ApiNodeData } from '../ApiNodeView';
import { GroupAreaNode, type GroupAreaData } from '../GroupAreaNode';
import { CaseAreaNode } from '../CaseAreaNode';
import { autoLayout } from '../layout';
import { branchKey, type ApiNode, type EndpointDescriptor, type Run, type Scenario } from '../api';
import { normalisePath } from '../App';

/** Custom RF node renderers — kept here so every consumer references the same identity. */
export const nodeTypes = { api: ApiNodeView, groupArea: GroupAreaNode, caseArea: CaseAreaNode };

export const NEW_NODE_W = 220;
export const NEW_NODE_H = 80;

const GROUP_PALETTE = ['#a855f7', '#06b6d4', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];

export function colorForGroup(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return GROUP_PALETTE[Math.abs(h) % GROUP_PALETTE.length];
}

/** Map a group id to one of N predefined ring colour buckets so multiple groups read distinct. */
export function groupHashClass(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}

// ─── RF id codecs ──────────────────────────────────────────────────────────
// Group/case areas live in the same RF node array as api nodes; we tag their ids with a
// short prefix so a glance at the id string tells us what we're dealing with.

const GROUP_RF_PREFIX = 'group::';
export function groupRfId(id: string): string { return `${GROUP_RF_PREFIX}${id}`; }
export function isGroupRfNode(n: RFNode): boolean { return n.id.startsWith(GROUP_RF_PREFIX); }
export function groupIdFromRf(rfId: string): string { return rfId.slice(GROUP_RF_PREFIX.length); }

const CASE_RF_PREFIX = 'case::';
export function caseRfId(id: string): string { return `${CASE_RF_PREFIX}${id}`; }
export function isCaseRfNode(n: RFNode): boolean { return n.id.startsWith(CASE_RF_PREFIX); }
export function caseIdFromRf(rfId: string): string { return rfId.slice(CASE_RF_PREFIX.length); }
export function isStructuralRf(n: RFNode): boolean { return isGroupRfNode(n) || isCaseRfNode(n); }

// Branch clones: synthetic api-node copies spawned per branch so the canvas literally shows
// each iteration as a separate node fanned out from its original. Encoded as
// `<originalNodeId>@@<branchKey>` in the RF id space; original `apiNodes[]` is unaware.
export const BRANCH_CLONE_SEP = '@@';
export const BRANCH_EDGE_PREFIX = 'bedge::';
export const BRANCH_LANE_SPREAD = 280;

export function branchCloneRfId(nodeId: string, branchKey: string): string {
  return `${nodeId}${BRANCH_CLONE_SEP}${branchKey}`;
}

export function parseBranchCloneRf(rfId: string): { nodeId: string; branchKey: string } | null {
  const idx = rfId.indexOf(BRANCH_CLONE_SEP);
  if (idx < 0) return null;
  return { nodeId: rfId.slice(0, idx), branchKey: rfId.slice(idx + BRANCH_CLONE_SEP.length) };
}

export function isBranchCloneRf(n: RFNode): boolean { return parseBranchCloneRf(n.id) !== null; }
export function isBranchCloneEdge(e: RFEdge): boolean { return e.id.startsWith(BRANCH_EDGE_PREFIX); }
export function branchCloneEdgeId(origEdgeId: string, branchKey: string): string {
  return `${BRANCH_EDGE_PREFIX}${branchKey}::${origEdgeId}`;
}

/** True when this is a real, user-authored api node (not a structural rectangle or branch clone). */
export function isApiRf(n: RFNode): boolean { return !isStructuralRf(n) && !isBranchCloneRf(n); }

// ─── Graph utilities ───────────────────────────────────────────────────────

/** BFS over edges from the anchor; returns set of reachable node ids (including the anchor). */
export function collectDescendants(anchorId: string, edges: RFEdge[]): Set<string> {
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

export function seedFromEndpoint(id: string, ep: EndpointDescriptor): ApiNode {
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

export function nextNodeId(existing: RFNode[], method: string, path: string): string {
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

export function buildFromScenario(scenario: Scenario): { nodes: RFNode[]; edges: RFEdge[] } {
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

/** Roll up a branch's per-node statuses into one chip status. */
export function aggregateBranchStatus(run: Run | null, key: string): 'running' | 'failed' | 'succeeded' | 'pending' {
  if (!run) return 'pending';
  const results = run.nodeResults.filter((r) => branchKey(r) === key);
  if (results.length === 0) return 'pending';
  if (results.some((r) => r.status === 'running' || r.status === 'paused')) return 'running';
  if (results.some((r) => r.status === 'failed')) return 'failed';
  if (results.every((r) => r.status === 'succeeded')) return 'succeeded';
  return 'pending';
}

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
