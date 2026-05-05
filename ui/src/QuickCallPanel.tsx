import { useEffect, useMemo, useState } from 'react';
import {
  quickCall,
  type EndpointDescriptor,
  type QuickCallRequest,
  type QuickCallResponse,
} from './api';

interface Props {
  endpoint: EndpointDescriptor;
  onClose: () => void;
}

interface PersistedShape {
  request: QuickCallRequest;
  history: HistoryEntry[];
}

interface HistoryEntry {
  timestamp: string;
  request: QuickCallRequest;
  response: QuickCallResponse;
}

const HISTORY_LIMIT = 20;

function storageKey(ep: EndpointDescriptor): string {
  return `apicover.quickcall.${ep.method.toUpperCase()}::${ep.path}`;
}

function loadPersisted(ep: EndpointDescriptor): PersistedShape | null {
  try {
    const raw = localStorage.getItem(storageKey(ep));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(ep: EndpointDescriptor, data: PersistedShape) {
  try {
    localStorage.setItem(storageKey(ep), JSON.stringify(data));
  } catch {
    /* ignore quota / privacy mode */
  }
}

function defaultRequestFor(ep: EndpointDescriptor): QuickCallRequest {
  const pathParameters: Record<string, string> = {};
  const queryParameters: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const p of ep.parameters ?? []) {
    const v = p.defaultValue !== undefined && p.defaultValue !== null ? String(p.defaultValue) : '';
    if (p.in === 'path') pathParameters[p.name] = v;
    else if (p.in === 'query') queryParameters[p.name] = v;
    else if (p.in === 'header') headers[p.name] = v;
  }
  let body: unknown;
  const sample = ep.samples?.[0]?.jsonPayload;
  if (sample) {
    try { body = JSON.parse(sample); } catch { body = sample; }
  }
  return { method: ep.method, path: ep.path, pathParameters, queryParameters, headers, body };
}

/**
 * Quick Call modal. Right column shows the response; left column is the request form.
 * Persists per (METHOD path) to localStorage. On open, if saved values exist, the
 * call auto-fires; otherwise the user fills in and clicks Run. History of past calls
 * appears at the top — clicking an entry restores its values and replays the call.
 */
export function QuickCallPanel({ endpoint, onClose }: Props) {
  const persistedInitial = useMemo(() => loadPersisted(endpoint), [endpoint]);

  const [req, setReq] = useState<QuickCallRequest>(
    () => persistedInitial?.request ?? defaultRequestFor(endpoint)
  );
  const [history, setHistory] = useState<HistoryEntry[]>(
    () => persistedInitial?.history ?? []
  );
  const [response, setResponse] = useState<QuickCallResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [bodyText, setBodyText] = useState<string>(() => stringifyBody(persistedInitial?.request?.body ?? defaultRequestFor(endpoint).body));
  const [bodyError, setBodyError] = useState<string | null>(null);

  // Auto-run when opening with persisted values.
  useEffect(() => {
    if (persistedInitial) {
      void run(persistedInitial.request);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every form change so the next open has fresh defaults.
  useEffect(() => {
    savePersisted(endpoint, { request: req, history });
  }, [endpoint, req, history]);

  async function run(requestOverride?: QuickCallRequest) {
    const toSend = requestOverride ?? req;
    setRunning(true);
    setResponse(null);
    try {
      const res = await quickCall(toSend);
      setResponse(res);
      const entry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        request: toSend,
        response: res,
      };
      setHistory((prev) => [entry, ...prev].slice(0, HISTORY_LIMIT));
    } catch (e) {
      setResponse({ error: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  function patchPath(name: string, value: string) {
    setReq((r) => ({ ...r, pathParameters: { ...r.pathParameters, [name]: value } }));
  }
  function patchQuery(name: string, value: string) {
    setReq((r) => ({ ...r, queryParameters: { ...r.queryParameters, [name]: value } }));
  }
  function patchHeader(name: string, value: string) {
    setReq((r) => ({ ...r, headers: { ...r.headers, [name]: value } }));
  }
  function commitBody(text: string) {
    setBodyText(text);
    if (text.trim().length === 0) {
      setBodyError(null);
      setReq((r) => ({ ...r, body: undefined }));
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setBodyError(null);
      setReq((r) => ({ ...r, body: parsed }));
    } catch (e) {
      setBodyError((e as Error).message);
    }
  }
  function loadHistory(entry: HistoryEntry) {
    setReq(entry.request);
    setBodyText(stringifyBody(entry.request.body));
    setBodyError(null);
    void run(entry.request);
  }
  function clearHistory() {
    setHistory([]);
  }

  const declaredPath = (endpoint.parameters ?? []).filter((p) => p.in === 'path');
  const declaredQuery = (endpoint.parameters ?? []).filter((p) => p.in === 'query');
  const declaredHeader = (endpoint.parameters ?? []).filter((p) => p.in === 'header');
  const status = response?.response?.status;
  const respBody = response?.response?.body;

  return (
    <div className="quick-modal-backdrop" onClick={onClose}>
      <div className="quick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="quick-modal-head">
          <span className={`method-badge method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <code className="quick-modal-path">{endpoint.path}</code>
          {endpoint.area && <span className="muted small">· {endpoint.area}</span>}
          <div className="quick-modal-actions">
            <button className="btn primary" onClick={() => run()} disabled={running || !!bodyError}>
              {running ? '● calling…' : '▶ Run'}
            </button>
            <button className="btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="quick-modal-body">
          {/* left: request form + history */}
          <div className="quick-col quick-col-left">
            {history.length > 0 && (
              <details className="quick-history" open>
                <summary>history · {history.length} <button className="kv-del" onClick={(e) => { e.preventDefault(); clearHistory(); }}>clear</button></summary>
                <ul className="quick-history-list">
                  {history.map((h, i) => {
                    const status = h.response.response?.status ?? (h.response.error ? '×' : '?');
                    const cls = typeof status === 'number'
                      ? (status >= 200 && status < 300 ? 'ok' : 'fail')
                      : 'fail';
                    return (
                      <li key={i} onClick={() => loadHistory(h)} className={`quick-history-item ${cls}`}>
                        <span className="quick-history-status">{status}</span>
                        <span className="quick-history-time">{new Date(h.timestamp).toLocaleTimeString()}</span>
                        <span className="quick-history-elapsed muted small">{h.response.elapsedMs?.toFixed(0)}ms</span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}

            {declaredPath.length > 0 && (
              <section className="quick-section">
                <h4>path</h4>
                {declaredPath.map((p) => (
                  <label key={p.name} className="quick-row">
                    <span className="quick-key">{p.name}</span>
                    <input
                      value={req.pathParameters?.[p.name] ?? ''}
                      placeholder={p.type ?? 'value'}
                      onChange={(e) => patchPath(p.name, e.target.value)}
                    />
                  </label>
                ))}
              </section>
            )}

            {declaredQuery.length > 0 && (
              <section className="quick-section">
                <h4>query</h4>
                {declaredQuery.map((p) => (
                  <label key={p.name} className="quick-row">
                    <span className="quick-key">{p.name}</span>
                    <input
                      value={req.queryParameters?.[p.name] ?? ''}
                      placeholder={p.type ?? 'value'}
                      onChange={(e) => patchQuery(p.name, e.target.value)}
                    />
                  </label>
                ))}
              </section>
            )}

            {declaredHeader.length > 0 && (
              <section className="quick-section">
                <h4>headers</h4>
                {declaredHeader.map((p) => (
                  <label key={p.name} className="quick-row">
                    <span className="quick-key">{p.name}</span>
                    <input
                      value={req.headers?.[p.name] ?? ''}
                      placeholder={p.type ?? 'value'}
                      onChange={(e) => patchHeader(p.name, e.target.value)}
                    />
                  </label>
                ))}
              </section>
            )}

            {(endpoint.requestBody || (endpoint.method !== 'GET' && endpoint.method !== 'HEAD')) && (
              <section className="quick-section">
                <h4>body (json)</h4>
                <textarea
                  className="quick-body"
                  rows={10}
                  value={bodyText}
                  onChange={(e) => commitBody(e.target.value)}
                  placeholder="{}"
                  spellCheck={false}
                />
                {bodyError && <div className="error small">{`[!] invalid JSON: ${bodyError}`}</div>}
              </section>
            )}
          </div>

          {/* right: response */}
          <div className="quick-col quick-col-right">
            <div className="quick-resp-head">
              <span className="muted small">response</span>
              {status !== undefined && (
                <span className={`quick-status ${status >= 200 && status < 300 ? 'ok' : 'fail'}`}>
                  {status}
                </span>
              )}
              {response?.elapsedMs !== undefined && (
                <span className="muted small">{response.elapsedMs.toFixed(0)}ms</span>
              )}
            </div>
            {response?.error && (
              <pre className="quick-error">{response.error}</pre>
            )}
            {respBody !== undefined && (
              <pre className="quick-resp-body">{JSON.stringify(respBody, null, 2)}</pre>
            )}
            {!response && !running && (
              <div className="muted small quick-resp-empty">no response yet — fill values and click Run.</div>
            )}
            {running && <div className="muted small">calling…</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function stringifyBody(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
