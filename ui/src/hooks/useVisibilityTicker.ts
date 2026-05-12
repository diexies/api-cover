import { useEffect, useState } from 'react';

/**
 * Drives a 1s tick used to refresh relative-time labels ("Saved · 12s ago").
 * Pauses when the tab is hidden so we don't re-render off-screen.
 * Returns a counter; consumers just need a reference for re-render.
 */
export function useVisibilityTicker(enabled: boolean, intervalMs = 1000): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(() => setTick((n) => n + 1), intervalMs);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVis = () => (document.visibilityState === 'hidden' ? stop() : start());
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, intervalMs]);

  return tick;
}
