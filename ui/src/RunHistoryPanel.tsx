import { useEffect, useState } from 'react';
import {
  getScenarioHistoryRun,
  listScenarioHistory,
  type Run,
  type ScenarioHistoryEntry,
} from './api';

interface Props {
  scenarioId: string;
  /** Bumped externally (e.g. when a fresh run finishes) to force a refetch. */
  refreshTick?: number;
}

/**
 * Per-scenario disk-persisted run history (last 10 terminal runs). Each row shows
 * status, timestamps, and a copy-to-clipboard button that emits a markdown timeline
 * for paste-into-PR / paste-into-slack workflows.
 */
export function RunHistoryPanel({ scenarioId, refreshTick }: Props) {
  const [entries, setEntries] = useState<ScenarioHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listScenarioHistory(scenarioId)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scenarioId, refreshTick]);

  async function copyMarkdown(entry: ScenarioHistoryEntry) {
    try {
      const run = await getScenarioHistoryRun(scenarioId, entry.id);
      const md = formatRunMarkdown(run);
      await navigator.clipboard.writeText(md);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1800);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading && entries.length === 0) {
    return <div className="run-history-empty">loading history…</div>;
  }
  if (error) {
    return <div className="run-history-empty run-history-err">history error: {error}</div>;
  }
  if (entries.length === 0) {
    return <div className="run-history-empty">No runs yet. Hit Run on this scenario to record one.</div>;
  }

  return (
    <div className="run-history">
      <div className="run-history-head">
        <span className="run-history-title">Recent runs</span>
        <span className="run-history-sub">last {entries.length} (cap 10)</span>
      </div>
      <ul className="run-history-list" role="list">
        {entries.map((e) => (
          <li key={e.id} className={`run-history-row status-${e.status.toLowerCase()}`}>
            <span className={`run-history-status status-${e.status.toLowerCase()}`}>{e.status}</span>
            <div className="run-history-meta">
              <div className="run-history-when">{formatWhen(e.startedAt)}</div>
              <div className="run-history-stats">
                {e.nodeCount} node{e.nodeCount === 1 ? '' : 's'}
                {e.failedNodeCount > 0 ? ` · ${e.failedNodeCount} failed` : ''}
                {e.error ? ` · ${truncate(e.error, 60)}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="run-history-copy"
              onClick={() => copyMarkdown(e)}
              title="Copy run timeline as markdown"
            >
              {copiedId === e.id ? '✓ copied' : '📋 copy'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function formatRunMarkdown(run: Run): string {
  const lines: string[] = [];
  lines.push(`# Run ${run.id}`);
  lines.push('');
  lines.push(`- **scenario**: \`${run.scenarioId}\``);
  lines.push(`- **status**: ${run.status}`);
  lines.push(`- **started**: ${run.startedAt}`);
  if (run.completedAt) lines.push(`- **completed**: ${run.completedAt}`);
  if (run.error) lines.push(`- **error**: ${run.error}`);
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  const results = (run as unknown as { nodeResults?: Array<Record<string, unknown>> }).nodeResults;
  if (!results || results.length === 0) {
    lines.push('_(no node results recorded)_');
    return lines.join('\n');
  }
  for (const nr of results) {
    const nodeId = String(nr.nodeId ?? '');
    const status = String(nr.status ?? '');
    const req = nr.request as Record<string, unknown> | undefined;
    const res = nr.response as Record<string, unknown> | undefined;
    const method = req?.method ?? '?';
    const url = req?.url ?? req?.path ?? '?';
    const resStatus = res?.status ?? '—';
    const duration = formatDuration(nr.startedAt as string | undefined, nr.completedAt as string | undefined);
    lines.push(`### ${nodeId} · ${status}`);
    lines.push(`**${method}** \`${url}\` → \`${resStatus}\`${duration ? ` _(${duration})_` : ''}`);
    if (req?.body !== undefined && req.body !== null) {
      lines.push('');
      lines.push('Request body:');
      lines.push('```json');
      lines.push(stringifyTrim(req.body));
      lines.push('```');
    }
    if (res?.body !== undefined && res.body !== null) {
      lines.push('');
      lines.push('Response body:');
      lines.push('```json');
      lines.push(stringifyTrim(res.body));
      lines.push('```');
    }
    if (nr.error) {
      lines.push('');
      lines.push(`> error: ${String(nr.error)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function stringifyTrim(value: unknown, max = 4000): string {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length <= max ? s : s.slice(0, max) + '\n…(truncated)';
  } catch {
    return String(value);
  }
}

function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
