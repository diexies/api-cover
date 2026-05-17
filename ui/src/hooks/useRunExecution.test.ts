import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRunExecution } from './useRunExecution';
import * as api from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    startRun: vi.fn(),
    subscribeRunEvents: vi.fn(),
    getRun: vi.fn(),
  };
});

const startRunMock = vi.mocked(api.startRun);
const subscribeRunEventsMock = vi.mocked(api.subscribeRunEvents);

const authNone = { type: 'none' as const };

describe('useRunExecution', () => {
  beforeEach(() => {
    startRunMock.mockReset();
    subscribeRunEventsMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initial state idle', () => {
    const { result } = renderHook(() => useRunExecution({
      scenarioId: 's1',
      auth: authNone,
      forceSaveIfDirty: async () => {},
      onError: () => {},
    }));
    expect(result.current.run).toBeNull();
    expect(result.current.running).toBe(false);
    expect(result.current.sseStatus).toBeNull();
  });

  it('start() awaits forceSaveIfDirty then calls startRun + subscribeRunEvents', async () => {
    const fakeRun = { id: 'r1', scenarioId: 's1', status: 'running', startedAt: '', nodeResults: [] } as unknown as api.Run;
    startRunMock.mockResolvedValue(fakeRun);
    subscribeRunEventsMock.mockReturnValue(() => {});
    const calls: string[] = [];
    const force = vi.fn(async () => { calls.push('save'); });
    const { result } = renderHook(() => useRunExecution({
      scenarioId: 's1',
      auth: authNone,
      forceSaveIfDirty: force,
      onError: () => {},
    }));
    await act(async () => { await result.current.start(); });
    expect(force).toHaveBeenCalledOnce();
    expect(startRunMock).toHaveBeenCalledOnce();
    expect(subscribeRunEventsMock).toHaveBeenCalledOnce();
    expect(result.current.run?.id).toBe('r1');
    expect(result.current.running).toBe(true);
  });

  it('start() aborts when forceSaveIfDirty throws', async () => {
    const force = vi.fn(async () => { throw new Error('save-failed'); });
    const { result } = renderHook(() => useRunExecution({
      scenarioId: 's1',
      auth: authNone,
      forceSaveIfDirty: force,
      onError: () => {},
    }));
    await act(async () => { await result.current.start(); });
    expect(startRunMock).not.toHaveBeenCalled();
    expect(result.current.running).toBe(false);
  });

  it('reset() unsubscribes and clears run state', async () => {
    const fakeRun = { id: 'r1', scenarioId: 's1', status: 'running', startedAt: '', nodeResults: [] } as unknown as api.Run;
    startRunMock.mockResolvedValue(fakeRun);
    const unsubscribe = vi.fn();
    subscribeRunEventsMock.mockReturnValue(unsubscribe);
    const { result } = renderHook(() => useRunExecution({
      scenarioId: 's1',
      auth: authNone,
      forceSaveIfDirty: async () => {},
      onError: () => {},
    }));
    await act(async () => { await result.current.start(); });
    expect(result.current.run).toBeTruthy();
    act(() => result.current.reset());
    expect(unsubscribe).toHaveBeenCalled();
    expect(result.current.run).toBeNull();
    expect(result.current.running).toBe(false);
    expect(result.current.sseStatus).toBeNull();
  });

  it('start() surfaces errors via onError', async () => {
    startRunMock.mockRejectedValue(new Error('connection refused'));
    const onError = vi.fn();
    const { result } = renderHook(() => useRunExecution({
      scenarioId: 's1',
      auth: authNone,
      forceSaveIfDirty: async () => {},
      onError,
    }));
    await act(async () => { await result.current.start(); });
    expect(onError).toHaveBeenCalledWith('connection refused');
    expect(result.current.running).toBe(false);
  });
});
