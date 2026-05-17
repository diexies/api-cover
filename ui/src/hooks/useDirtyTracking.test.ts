import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDirtyTracking } from './useDirtyTracking';

describe('useDirtyTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initial state is clean', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [] }),
    );
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.lastSavedAt).toBeNull();
  });

  it('fires save 800ms after dirty flip', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [] }),
    );
    act(() => result.current.setDirty(true));
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(799);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it('backs off to 5000ms when err is non-null', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: 'boom', save, watch: [] }),
    );
    act(() => result.current.setDirty(true));
    vi.advanceTimersByTime(800);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4199);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not save while running', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: true, err: null, save, watch: [] }),
    );
    act(() => result.current.setDirty(true));
    vi.advanceTimersByTime(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not save while saving', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [] }),
    );
    act(() => { result.current.setDirty(true); result.current.setSaving(true); });
    vi.advanceTimersByTime(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('exposes synchronously-current dirty flag via dirtyRef', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [] }),
    );
    expect(result.current.dirtyRef.current).toBe(false);
    act(() => result.current.setDirty(true));
    expect(result.current.dirtyRef.current).toBe(true);
  });

  it('saveRef points at the latest save closure', () => {
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ save }: { save: () => Promise<void> }) =>
        useDirtyTracking({ running: false, err: null, save, watch: [] }),
      { initialProps: { save: saveA } },
    );
    void result.current.saveRef.current();
    expect(saveA).toHaveBeenCalledOnce();
    rerender({ save: saveB });
    void result.current.saveRef.current();
    expect(saveB).toHaveBeenCalledOnce();
  });

  it('attaches beforeunload listener when dirty or saving', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { result } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [] }),
    );
    // Clean: no beforeunload registration.
    expect(addSpy.mock.calls.find(([name]) => name === 'beforeunload')).toBeUndefined();
    act(() => result.current.setDirty(true));
    expect(addSpy.mock.calls.find(([name]) => name === 'beforeunload')).toBeDefined();
    addSpy.mockRestore();
  });

  it('watch tuple change re-arms the debounce', () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let watchValue = 1;
    const { result, rerender } = renderHook(() =>
      useDirtyTracking({ running: false, err: null, save, watch: [watchValue] }),
    );
    act(() => result.current.setDirty(true));
    vi.advanceTimersByTime(400);
    // New edit comes in — bump the watch tuple
    watchValue = 2;
    rerender();
    vi.advanceTimersByTime(400);
    expect(save).not.toHaveBeenCalled(); // total elapsed = 800ms BUT timer was reset at 400
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledOnce();
  });
});
