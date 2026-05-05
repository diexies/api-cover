import { useState } from 'react';
import type { NodeIteration } from '../api';

interface Props {
  iterations: NodeIteration[];
}

export function IterationList({ iterations }: Props) {
  return (
    <div className="iter-list">
      {iterations.map((it) => (
        <IterationRow key={it.index} it={it} />
      ))}
    </div>
  );
}

function IterationRow({ it }: { it: NodeIteration }) {
  const [open, setOpen] = useState(false);
  const cls = it.status === 'succeeded' ? 'iter-ok' : it.status === 'failed' ? 'iter-fail' : 'iter-pending';
  const code = it.response?.status;
  const ms = computeMs(it.startedAt, it.completedAt);
  return (
    <div className={`iter-row ${cls}`}>
      <div className="iter-head" onClick={() => setOpen((v) => !v)}>
        <span className="iter-toggle">{open ? '▾' : '▸'}</span>
        <span className="iter-idx">#{it.index}</span>
        <span className="iter-code">{code ? `${code} ${codeLabel(code)}` : it.status.toUpperCase()}</span>
        {ms != null && <span className="iter-ms">· {formatMs(ms)}</span>}
      </div>
      {open && (
        <div className="iter-body">
          {it.request?.body !== undefined && (
            <div>
              <div className="muted small">{`> request body`}</div>
              <pre>{JSON.stringify(it.request.body, null, 2)}</pre>
            </div>
          )}
          {it.response?.body !== undefined && (
            <div>
              <div className="muted small">{`> response body`}</div>
              <pre>{JSON.stringify(it.response.body, null, 2)}</pre>
            </div>
          )}
          {it.error && <div className="error small">{`[!] ${it.error}`}</div>}
        </div>
      )}
    </div>
  );
}

function codeLabel(code: number): string {
  if (code >= 200 && code < 300) return 'OK';
  if (code >= 300 && code < 400) return 'REDIR';
  if (code >= 400 && code < 500) return 'ERR';
  if (code >= 500) return 'FAIL';
  return '';
}

function computeMs(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
