import type { EndpointDescriptor, Scenario } from '../api';
import { normalisePath } from '../App';

export { normalisePath };

/**
 * Coverage stats for a workspace: how many discovered endpoints are touched
 * by at least one scenario node. Mirrors the StatsSection KPI math so that
 * compact stat rows on home and the full drill-down agree to the percent.
 */
export function coverage(endpoints: EndpointDescriptor[], scenarios: Scenario[]) {
  const used = new Set<string>();
  for (const s of scenarios) {
    for (const n of s.nodes) used.add(`${n.method.toUpperCase()} ${normalisePath(n.path)}`);
  }
  let c = 0;
  for (const ep of endpoints) {
    if (used.has(`${ep.method.toUpperCase()} ${normalisePath(ep.path)}`)) c++;
  }
  return {
    covered: c,
    uncovered: endpoints.length - c,
    pct: endpoints.length === 0 ? 0 : Math.round((c / endpoints.length) * 100),
  };
}

/**
 * Relative time formatter — "just now", "2m ago", "3h ago", "yesterday", "3d ago".
 * Used by RecentSessions row meta. Falls back to ISO date for anything older
 * than a week so absolute time stays useful for stale sessions.
 */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.max(1, Math.round((now - t) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}
