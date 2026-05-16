import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InspectorPanel } from './InspectorPanel';
import type { ApiNode, EndpointDescriptor } from '../api';

// NodeInspector pulls in xyflow + inspector tabs which need a heavy mock to render.
// We replace it with a marker that surfaces a few key props for assertion.
vi.mock('../NodeInspector', () => ({
  NodeInspector: (props: Record<string, unknown>) => (
    <div data-testid="node-inspector" data-node-id={(props.node as ApiNode).id}>
      <span data-testid="upstream-count">{((props.upstreamIds as string[]) ?? []).length}</span>
      <span data-testid="downstream-count">{((props.downstreamIds as string[]) ?? []).length}</span>
      <span data-testid="scenario-name">{String(props.scenarioName)}</span>
    </div>
  ),
}));

const NODE: ApiNode = {
  id: 'login',
  method: 'POST',
  path: '/auth/login',
};

const ENDPOINT: EndpointDescriptor = {
  id: 'POST /auth/login',
  method: 'POST',
  path: '/auth/login',
} as unknown as EndpointDescriptor;

const baseProps = {
  selectedApiNode: NODE,
  endpointLookup: new Map([['POST /auth/login', ENDPOINT]]),
  scenariosUsingEndpoint: undefined,
  endpointStatsByKey: undefined,
  run: null,
  apiNodes: [NODE],
  edges: [
    { id: 'e1', source: 'pre', target: 'login' },
    { id: 'e2', source: 'login', target: 'next' },
  ] as Array<{ id: string; source: string; target: string }>,
  groups: [],
  caseSets: [],
  startNodeIds: [],
  scenarioName: 'demo-flow',
  onPatchNode: () => {},
  onToggleStart: () => {},
  onClose: () => {},
  onFocusNode: () => {},
  onEditGroup: () => {},
  onCaseSetChange: () => {},
};

describe('InspectorPanel', () => {
  it('renders nothing when no api node selected', () => {
    const { container } = render(<InspectorPanel {...baseProps} selectedApiNode={null} />);
    expect(container.querySelector('[data-testid="node-inspector"]')).toBeNull();
    expect(container.querySelector('.inspector-resize')).toBeNull();
  });

  it('renders resize handle and inspector when a node is selected', () => {
    render(<InspectorPanel {...baseProps} />);
    expect(screen.getByTestId('node-inspector')).toHaveAttribute('data-node-id', 'login');
    expect(document.querySelector('.inspector-resize')).toBeTruthy();
  });

  it('derives upstream/downstream node ids from edges', () => {
    render(<InspectorPanel {...baseProps} />);
    expect(screen.getByTestId('upstream-count').textContent).toBe('1');
    expect(screen.getByTestId('downstream-count').textContent).toBe('1');
  });

  it('forwards scenario name', () => {
    render(<InspectorPanel {...baseProps} scenarioName="another" />);
    expect(screen.getByTestId('scenario-name').textContent).toBe('another');
  });
});
