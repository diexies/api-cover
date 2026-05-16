import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScenarioHistory, type ScenarioSnapshot } from './useScenarioHistory';

function snap(name: string): ScenarioSnapshot {
  return {
    apiNodes: [{ id: 'n1', method: 'GET', path: '/' }] as ScenarioSnapshot['apiNodes'],
    breakpoints: [],
    startNodeIds: [],
    groups: [],
    caseSets: [],
    flowName: name,
    flowDescription: '',
    flowTags: [],
  };
}

describe('useScenarioHistory', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('initial state cannot undo or redo', () => {
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useScenarioHistory({ current: snap('init'), apply }),
    );
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('pushes after debounce when current diverges', () => {
    const apply = vi.fn();
    let current = snap('a');
    const { result, rerender } = renderHook(() =>
      useScenarioHistory({ current, apply }),
    );
    current = snap('b');
    rerender();
    expect(result.current.canUndo).toBe(false); // debounce not yet fired
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.canUndo).toBe(true);
  });

  it('undo applies the previous snapshot', () => {
    const apply = vi.fn();
    let current = snap('a');
    const { result, rerender } = renderHook(() =>
      useScenarioHistory({ current, apply }),
    );
    current = snap('b');
    rerender();
    act(() => { vi.advanceTimersByTime(400); });
    act(() => result.current.undo());
    expect(apply).toHaveBeenCalledOnce();
    expect((apply.mock.calls[0][0] as ScenarioSnapshot).flowName).toBe('a');
  });

  it('redo replays a previously undone snapshot', () => {
    const apply = vi.fn();
    let current = snap('a');
    const { result, rerender } = renderHook(() =>
      useScenarioHistory({ current, apply }),
    );
    current = snap('b');
    rerender();
    act(() => { vi.advanceTimersByTime(400); });
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect((apply.mock.calls[apply.mock.calls.length - 1][0] as ScenarioSnapshot).flowName).toBe('b');
  });

  it('reset() drops the stack', () => {
    const apply = vi.fn();
    let current = snap('a');
    const { result, rerender } = renderHook(() =>
      useScenarioHistory({ current, apply }),
    );
    current = snap('b');
    rerender();
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.reset(snap('fresh')));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('truncates redo tail when new edit lands after an undo', () => {
    const apply = vi.fn();
    let current = snap('a');
    const { result, rerender } = renderHook(() =>
      useScenarioHistory({ current, apply }),
    );
    current = snap('b'); rerender(); act(() => { vi.advanceTimersByTime(400); });
    current = snap('c'); rerender(); act(() => { vi.advanceTimersByTime(400); });
    act(() => result.current.undo()); // back to b
    expect(result.current.canRedo).toBe(true);
    current = snap('d'); rerender(); act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.canRedo).toBe(false); // c truncated
  });
});
