import type { NodeResult } from '../api';
import { ResponseViewer } from '../components/ResponseViewer';

interface Props {
  result?: NodeResult;
}

/**
 * Inspector "Response" tab — shows the latest NodeResult for the selected node, with
 * request + response side by side. Empty state when no run has touched this node yet.
 */
export function ResponseTab({ result }: Props) {
  if (!result) {
    return (
      <div className="response-tab-empty">
        <div className="muted small">{`> no run results for this node yet.`}</div>
        <div className="muted small">{`> hit ▶ Run on the toolbar, or pick a row from the history drawer.`}</div>
      </div>
    );
  }
  const timing = formatTiming(result.startedAt, result.completedAt);
  return (
    <div className="response-tab">
      <div className="response-tab-meta">
        <span className={`response-tab-status status-${result.status}`}>{result.status}</span>
        {timing && <span className="muted small">{timing}</span>}
      </div>
      <ResponseViewer
        request={result.request}
        response={result.response}
        error={result.error}
      />
    </div>
  );
}

function formatTiming(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
