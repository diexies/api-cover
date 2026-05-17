import { useEffect, useState } from 'react';
import {
  getScenarioHistoryRun,
  listScenarioHistory,
  type Run,
  type ScenarioHistoryEntry,
} from './api';
import { ResponseViewer } from './components/ResponseViewer';

interface Props {
  scenarioId: string;
  /** Bumped externally (e.g. when a fresh run finishes) to force a refetch. */
  refreshTick?: number;
  /** Click handler — fetches the historical run and hands it back to the caller. */
  onOpenRun?: (run: Run) => void;
  /** Highlighted row when set; matches the current viewing run id. */
  activeRunId?: string | null;
  /** Full Run object for the active row. When provided, an inline detail list expands
   *  showing every node result; clicking one focuses that node in the canvas inspector. */
  activeRun?: Run | null;
  /** Focus a node id in the canvas (selects it so the inspector opens with response tab). */
  onPickNode?: (nodeId: string) => void;
}

/**
 * Per-scenario disk-persisted run history (last 10 terminal runs). Each row shows
 * status, timestamps, and a copy-to-clipboard button that emits a markdown timeline
 * for paste-into-PR / paste-into-slack workflows.
 */
export function RunHistoryPanel({ scenarioId, refreshTick, onOpenRun, activeRunId, activeRun, onPickNode }: Props) {
  const [entries, setEntries] = useState<ScenarioHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Index of the node-result row expanded inside the active run's detail list. */
  const [expandedNodeIdx, setExpandedNodeIdx] = useState<number | null>(null);
  // Reset expansion when the active run changes — old indices don't carry over.
  useEffect(() => { setExpandedNodeIdx(null); }, [activeRunId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listScenarioHistory(scenarioId)
      .then((list) => {
        if (cancelled) return;
        // Dedupe by id — backend ring buffer can repeat ids when a run is replayed
        // or when the in-memory + persisted stores race. Keep the first occurrence.
        const seen = new Set<string>();
        const unique = list.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
        setEntries(unique);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scenarioId, refreshTick]);

  async function openRun(entry: ScenarioHistoryEntry) {
    if (!onOpenRun) return;
    try {
      const run = await getScenarioHistoryRun(scenarioId, entry.id);
      onOpenRun(run);
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
        {entries.map((e) => {
          const isActive = activeRunId === e.id;
          const clickable = !!onOpenRun;
          return (
            <li
              key={e.id}
              className={`run-history-row status-${e.status.toLowerCase()}${isActive ? ' is-active' : ''}${clickable ? ' is-clickable' : ''}`}
              onClick={clickable ? () => openRun(e) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : -1}
              onKeyDown={clickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRun(e); } } : undefined}
              aria-pressed={clickable ? isActive : undefined}
            >
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
                onClick={(ev) => { ev.stopPropagation(); copyMarkdown(e); }}
                title="Copy run timeline as markdown"
              >
                {copiedId === e.id ? '✓ copied' : '📋 copy'}
              </button>
              {isActive && activeRun && activeRun.id === e.id && (
                <ul className="run-history-detail" role="list">
                  {activeRun.nodeResults.map((nr, i) => {
                    const isOpen = expandedNodeIdx === i;
                    return (
                      <li
                        key={`${nr.nodeId}-${i}`}
                        className={`run-history-detail-row status-${nr.status}${isOpen ? ' is-open' : ''}`}
                      >
                        <div
                          className="run-history-detail-summary"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setExpandedNodeIdx(isOpen ? null : i);
                            onPickNode?.(nr.nodeId);
                          }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isOpen}
                        >
                          <span className={`run-history-detail-caret${isOpen ? ' is-open' : ''}`} aria-hidden="true">▸</span>
                          <span className={`run-history-detail-status status-${nr.status}`}>{nr.status}</span>
                          <code className="run-history-detail-method">{nr.request?.method ?? '?'}</code>
                          <span className="run-history-detail-path">{nr.request?.path ?? nr.nodeId}</span>
                          {nr.response?.status !== undefined && (
                            <span className="run-history-detail-code">{nr.response.status}</span>
                          )}
                        </div>
                        {isOpen && (
                          <div className="run-history-detail-body" onClick={(ev) => ev.stopPropagation()}>
                            <ResponseViewer
                              request={nr.request}
                              response={nr.response}
                              error={nr.error}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
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
