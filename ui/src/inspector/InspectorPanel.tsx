import type { Edge as RFEdge } from '@xyflow/react';
import { NodeInspector } from '../NodeInspector';
import { useResizableWidth } from '../useResizableWidth';
import { normalisePath } from '../App';
import {
  aggregateNodeResult,
  type ApiNode,
  type CaseSet,
  type EndpointDescriptor,
  type ExecutionGroup,
  type Run,
} from '../api';

type EndpointStatBucket = {
  passed: number;
  failed: number;
  perScenario: Map<string, { passed: number; failed: number }>;
};

interface Props {
  selectedApiNode: ApiNode | null;
  endpointLookup: Map<string, EndpointDescriptor>;
  scenariosUsingEndpoint?: Map<string, { id: string; name: string }[]>;
  endpointStatsByKey?: Map<string, EndpointStatBucket>;
  run: Run | null;
  apiNodes: ApiNode[];
  edges: RFEdge[];
  groups: ExecutionGroup[];
  caseSets: CaseSet[];
  startNodeIds: string[];
  scenarioName: string;
  enableCallGraph?: boolean;
  onPatchNode: (id: string, patch: Partial<ApiNode>) => void;
  onToggleStart: (id: string) => void;
  onClose: () => void;
  onFocusNode: (id: string) => void;
  onEditGroup: (gid: string) => void;
  onCaseSetChange: (anchorId: string, next: CaseSet | undefined) => void;
}

/**
 * Right-side scenario inspector with its own resize handle. Renders nothing when no api
 * node is selected. Width persists via the central prefs store under
 * 'utopia.inspector.width' (untouched by the canvas split).
 */
export function InspectorPanel({
  selectedApiNode,
  endpointLookup,
  scenariosUsingEndpoint,
  endpointStatsByKey,
  run,
  apiNodes,
  edges,
  groups,
  caseSets,
  startNodeIds,
  scenarioName,
  enableCallGraph,
  onPatchNode,
  onToggleStart,
  onClose,
  onFocusNode,
  onEditGroup,
  onCaseSetChange,
}: Props) {
  const inspectorSize = useResizableWidth('utopia.inspector.width', 480, 320, 900);
  if (!selectedApiNode) return null;

  const key = `${selectedApiNode.method.toUpperCase()} ${normalisePath(selectedApiNode.path)}`;
  const endpoint = endpointLookup.get(key);
  const usingScenarios = scenariosUsingEndpoint?.get(key) ?? [];
  const statBucket = endpointStatsByKey?.get(key);
  const scenariosUsing = usingScenarios.map((s) => {
    const per = statBucket?.perScenario.get(s.id);
    return { id: s.id, name: s.name, passed: per?.passed ?? 0, failed: per?.failed ?? 0 };
  });
  const endpointTotals = { passed: statBucket?.passed ?? 0, failed: statBucket?.failed ?? 0 };

  return (
    <>
      <div
        className="resize-handle vertical inspector-resize"
        onMouseDown={(e) => inspectorSize.startResize(e, 'left')}
        title="Drag to resize inspector"
      />
      <NodeInspector
        node={selectedApiNode}
        width={inspectorSize.width}
        endpoint={endpoint}
        isStartNode={startNodeIds.includes(selectedApiNode.id)}
        groupsForNode={groups.filter((g) => g.nodeIds.includes(selectedApiNode.id))}
        iterations={aggregateNodeResult(run, selectedApiNode.id)?.iterations}
        siblings={apiNodes.filter((n) => n.id !== selectedApiNode.id)}
        upstreamIds={edges.filter((e) => e.target === selectedApiNode.id).map((e) => e.source)}
        downstreamIds={edges.filter((e) => e.source === selectedApiNode.id).map((e) => e.target)}
        scenariosUsing={scenariosUsing}
        endpointTotals={endpointTotals}
        scenarioName={scenarioName}
        onChange={(next) => onPatchNode(selectedApiNode.id, next)}
        onToggleStartNode={() => onToggleStart(selectedApiNode.id)}
        onClose={onClose}
        onFocusNode={onFocusNode}
        onEditGroup={onEditGroup}
        enableCallGraph={enableCallGraph}
        caseSetForNode={caseSets.find((c) => c.anchorNodeId === selectedApiNode.id)}
        onCaseSetChange={(next) => onCaseSetChange(selectedApiNode.id, next ?? undefined)}
      />
    </>
  );
}
