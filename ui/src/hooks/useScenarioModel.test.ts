import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useScenarioModel } from './useScenarioModel';
import * as api from '../api';
import type { Scenario } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    saveScenario: vi.fn().mockResolvedValue(undefined),
  };
});

const saveScenarioMock = vi.mocked(api.saveScenario);

function makeScenario(): Scenario {
  return {
    id: 's1',
    name: 'demo',
    nodes: [
      { id: 'a', method: 'GET', path: '/a', position: { x: 0, y: 0 } },
      { id: 'b', method: 'POST', path: '/b', position: { x: 200, y: 0 } },
    ],
    edges: [{ from: 'a', to: 'b' }],
    groups: [],
  } as Scenario;
}

function makeHookArgs(scenario: Scenario) {
  // Stable mock refs across re-renders so assertions see the same fn instance.
  const setDirty = vi.fn();
  const setSaving = vi.fn();
  const setLastSavedAt = vi.fn();
  const setErr = vi.fn();
  const onSaved = vi.fn();
  return {
    setDirty, setSaving, setLastSavedAt, setErr, onSaved,
    use: () => {
      const dirtyBridge = useRef<(v: boolean) => void>(setDirty);
      const savingBridge = useRef<(v: boolean) => void>(setSaving);
      const lastSavedAtBridge = useRef<(v: number | null) => void>(setLastSavedAt);
      const selectedNodeIdRef = useRef<string | null>(null);
      const selectedIdsRef = useRef<string[]>([]);
      dirtyBridge.current = setDirty;
      savingBridge.current = setSaving;
      lastSavedAtBridge.current = setLastSavedAt;
      const setNodes = vi.fn();
      const setEdges = vi.fn();
      const setSelectedNodeId = vi.fn();
      const setEditingGroupId = vi.fn();
      const model = useScenarioModel({
        scenario,
        nodes: [],
        edges: [],
        setNodes,
        setEdges,
        dirtyBridge,
        savingBridge,
        lastSavedAtBridge,
        setErr,
        onSaved,
        selectedNodeIdRef,
        setSelectedNodeId,
        selectedIdsRef,
        setEditingGroupId,
      });
      return model;
    },
  };
}

describe('useScenarioModel', () => {
  it('initialises authoritative state from scenario', () => {
    const args = makeHookArgs(makeScenario());
    const { result } = renderHook(args.use);
    expect(result.current.apiNodes).toHaveLength(2);
    expect(result.current.flowName).toBe('demo');
    expect(result.current.groups).toEqual([]);
  });

  it('patchApiNode merges patch and marks dirty', () => {
    const args = makeHookArgs(makeScenario());
    const { result } = renderHook(args.use);
    act(() => result.current.mutators.patchApiNode('a', { label: 'renamed' }));
    expect(result.current.apiNodes.find((n) => n.id === 'a')?.label).toBe('renamed');
    expect(args.setDirty).toHaveBeenCalledWith(true);
  });

  it('toggleBreakpoint adds/removes by nodeId', () => {
    const args = makeHookArgs(makeScenario());
    const { result } = renderHook(args.use);
    act(() => result.current.mutators.toggleBreakpoint('a'));
    expect(result.current.breakpoints).toEqual([{ nodeId: 'a', enabled: true }]);
    act(() => result.current.mutators.toggleBreakpoint('a'));
    expect(result.current.breakpoints).toEqual([]);
  });

  it('toggleStartNode toggles inclusion', () => {
    const args = makeHookArgs(makeScenario());
    const { result } = renderHook(args.use);
    act(() => result.current.mutators.toggleStartNode('a'));
    expect(result.current.startNodeIds).toEqual(['a']);
    act(() => result.current.mutators.toggleStartNode('a'));
    expect(result.current.startNodeIds).toEqual([]);
  });

  it('deleteNode cascades to breakpoints / startNodes / groups', () => {
    const scenario: Scenario = {
      ...makeScenario(),
      breakpoints: [{ nodeId: 'a', enabled: true }],
      startNodeIds: ['a'],
      groups: [{
        id: 'g1', label: 'G1', nodeIds: ['a', 'b'],
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        mutations: [{ nodeId: 'a', field: 'body.x', rule: 0 }],
      }],
    };
    const args = makeHookArgs(scenario);
    const { result } = renderHook(args.use);
    act(() => result.current.mutators.deleteNode('a'));
    expect(result.current.apiNodes.map((n) => n.id)).toEqual(['b']);
    expect(result.current.breakpoints).toEqual([]);
    expect(result.current.startNodeIds).toEqual([]);
    expect(result.current.groups[0].nodeIds).toEqual(['b']);
    expect(result.current.groups[0].mutations).toEqual([]);
  });

  it('deleteNode removes empty groups', () => {
    const scenario: Scenario = {
      ...makeScenario(),
      groups: [{ id: 'g1', label: 'G1', nodeIds: ['a'], bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    };
    const args = makeHookArgs(scenario);
    const { result } = renderHook(args.use);
    act(() => result.current.mutators.deleteNode('a'));
    expect(result.current.groups).toEqual([]);
  });

  it('onSave calls saveScenario with merged scenario', async () => {
    saveScenarioMock.mockClear();
    const args = makeHookArgs(makeScenario());
    const { result } = renderHook(args.use);
    await act(async () => { await result.current.onSave(); });
    expect(saveScenarioMock).toHaveBeenCalledOnce();
    const merged = saveScenarioMock.mock.calls[0][0] as Scenario;
    expect(merged.id).toBe('s1');
    expect(args.setLastSavedAt).toHaveBeenCalled();
    expect(args.onSaved).toHaveBeenCalled();
  });
});
