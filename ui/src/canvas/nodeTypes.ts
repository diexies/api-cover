import { ApiNodeView, type ApiNodeData } from '../ApiNodeView';
import { GroupAreaNode, type GroupAreaData } from '../GroupAreaNode';
import { CaseAreaNode, type CaseAreaData } from '../CaseAreaNode';

/**
 * Discriminated union of every node-data shape rendered on the canvas. XyFlow itself stores node
 * data as a loose `Record<string, unknown>`; this union lets call sites narrow with type guards
 * (`isApiNode`, etc.) instead of casting.
 */
export type CanvasNodeData = ApiNodeData | GroupAreaData | CaseAreaData;

export const nodeTypes = {
  api: ApiNodeView,
  groupArea: GroupAreaNode,
  caseArea: CaseAreaNode,
} as const;

export type NodeKind = keyof typeof nodeTypes;

export function isApiNodeData(d: unknown): d is ApiNodeData {
  return !!d && typeof d === 'object' && 'method' in (d as object) && 'path' in (d as object);
}
export function isGroupAreaData(d: unknown): d is GroupAreaData {
  return !!d && typeof d === 'object' && 'color' in (d as object) && !('method' in (d as object));
}
export function isCaseAreaData(d: unknown): d is CaseAreaData {
  return !!d && typeof d === 'object' && 'variantCount' in (d as object);
}
