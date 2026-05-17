import { useMemo, useState } from 'react';

export interface ResponseSnapshot {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RequestSnapshot {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface Props {
  response?: ResponseSnapshot;
  request?: RequestSnapshot;
  error?: string;
  /** When true, mounts in a compact balloon layout (no request panel). */
  compact?: boolean;
}

/**
 * Shared renderer for an api node's request/response snapshot. Used by the canvas balloon
 * and the inspector's Response tab. JSON pretty-print, copy-to-clipboard, status-coded
 * badge, headers behind an accordion.
 */
export function ResponseViewer({ response, request, error, compact }: Props) {
  const bodyText = useMemo(() => stringify(response?.body), [response?.body]);
  const reqBodyText = useMemo(() => stringify(request?.body), [request?.body]);

  return (
    <div className={`response-viewer${compact ? ' is-compact' : ''}`}>
      {error && (
        <div className="response-viewer-error" role="alert">
          <span className="response-viewer-error-icon" aria-hidden="true">✗</span>
          <span>{error}</span>
        </div>
      )}
      {response?.status !== undefined && (
        <div className="response-viewer-status-row">
          <StatusBadge status={response.status} />
          {request && (
            <span className="response-viewer-req-line">
              <code>{request.method ?? '?'}</code>
              <span className="response-viewer-path">{request.path ?? ''}</span>
            </span>
          )}
        </div>
      )}
      {!compact && request && (
        <CollapsibleSection title="Request">
          {request.headers && Object.keys(request.headers).length > 0 && (
            <HeadersTable headers={request.headers} />
          )}
          {reqBodyText && (
            <CodeBlock label="body" text={reqBodyText} />
          )}
          {!reqBodyText && (!request.headers || Object.keys(request.headers).length === 0) && (
            <div className="muted small">(no request body)</div>
          )}
        </CollapsibleSection>
      )}
      <CollapsibleSection title="Response body" defaultOpen>
        {bodyText
          ? <CodeBlock text={bodyText} />
          : <div className="muted small">(no response body)</div>}
      </CollapsibleSection>
      {!compact && response?.headers && Object.keys(response.headers).length > 0 && (
        <CollapsibleSection title="Response headers">
          <HeadersTable headers={response.headers} />
        </CollapsibleSection>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  const cls = status >= 500 ? 'is-5xx'
    : status >= 400 ? 'is-4xx'
    : status >= 300 ? 'is-3xx'
    : status >= 200 ? 'is-2xx'
    : 'is-1xx';
  return <span className={`response-viewer-status ${cls}`}>{status}</span>;
}

function CollapsibleSection({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="response-viewer-section"
    >
      <summary className="response-viewer-section-summary">{title}</summary>
      <div className="response-viewer-section-body">{children}</div>
    </details>
  );
}

function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const rows = Object.entries(headers);
  if (rows.length === 0) return null;
  return (
    <table className="response-viewer-headers">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td><code>{String(v)}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CodeBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }
  return (
    <div className="response-viewer-code">
      <div className="response-viewer-code-head">
        {label && <span className="response-viewer-code-label">{label}</span>}
        <button type="button" className="response-viewer-copy" onClick={copy}>
          {copied ? '✓ copied' : '📋 copy'}
        </button>
      </div>
      <pre className="response-viewer-pre">{text}</pre>
    </div>
  );
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
