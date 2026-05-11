import { useEffect, useState } from 'react';
import {
  type MemoryEntry,
  type SessionSummary,
  deleteMemoryFile,
  listActiveAgentRuns,
  listAgentSessions,
  listMemory,
  readMemoryFile,
  writeMemoryFile,
} from './api';

interface Props {
  onScan: () => void;
  scanBusy: boolean;
  /** Surface a Max-mode warning when the last scan no-oped due to the CLI bridge
   *  not supporting tool calls. */
  agentMode?: 'Disabled' | 'ApiKey' | 'Max';
  onOpenSettings?: (tab?: 'auth' | 'agent' | 'settings') => void;
}

/**
 * Memory tab inside AgentPanel. Two views: list of file cards (default) and a
 * single-file reader/editor. Clicking a card opens the reader; the back arrow
 * returns to the list. Mirrors the chat tab's recent-runs → transcript flow so
 * navigation feels consistent across the panel.
 */
export function AgentMemoryTab({ onScan, scanBusy, agentMode }: Props) {
  const [files, setFiles] = useState<MemoryEntry[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [root, setRoot] = useState<string>('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalScanRunning, setExternalScanRunning] = useState(false);
  const [lastScan, setLastScan] = useState<SessionSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newContent, setNewContent] = useState('');

  useEffect(() => { refresh(); refreshLastScan(); }, []);

  async function refreshLastScan() {
    try {
      const r = await listAgentSessions(20);
      const scan = r.sessions.find((s) => s.mode === 'scan' && s.status !== 'running');
      setLastScan(scan ?? null);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function poll() {
      try {
        const runs = await listActiveAgentRuns();
        if (!alive) return;
        const wasRunning = externalScanRunning;
        const isRunning = runs.some((r) => (r.mode ?? '').toLowerCase() === 'scan');
        setExternalScanRunning(isRunning);
        if (wasRunning && !isRunning) {
          refresh();
          refreshLastScan();
        }
      } catch { /* ignore */ }
    }
    poll();
    timer = setInterval(poll, 4000);
    return () => { alive = false; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const r = await listMemory();
      setFiles(r.files);
      setRoot(r.root);
      // Fetch previews in parallel for the card view. Capped to 50 in case
      // some pathological repo blows up memory listing.
      const slice = r.files.slice(0, 50);
      const pairs = await Promise.all(slice.map(async (f) => {
        try {
          const fr = await readMemoryFile(f.path);
          return [f.path, (fr?.content ?? '').trim()] as const;
        } catch { return [f.path, ''] as const; }
      }));
      setPreviews(Object.fromEntries(pairs));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string) {
    setSelectedPath(path);
    // Default to edit mode — the reader is the editor. Save button surfaces
    // automatically when draft diverges from saved content.
    setError(null);
    try {
      const r = await readMemoryFile(path);
      const text = r?.content ?? '';
      setContent(text);
      setDraft(text);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveDraft() {
    if (!selectedPath) return;
    setError(null);
    try {
      await writeMemoryFile(selectedPath, draft);
      setContent(draft);
      setPreviews((p) => ({ ...p, [selectedPath]: draft.trim() }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createFile() {
    const path = newPath.trim();
    if (!path) { setError('File name required.'); return; }
    setError(null);
    try {
      const finalPath = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.md`;
      await writeMemoryFile(finalPath, newContent);
      setAdding(false);
      setNewPath('');
      setNewContent('');
      await refresh();
      await openFile(finalPath);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteCurrent() {
    if (!selectedPath) return;
    if (!confirm(`Delete ${selectedPath}? The agent may recreate it on next scan.`)) return;
    try {
      await deleteMemoryFile(selectedPath);
      setSelectedPath(null);
      setContent('');
      setDraft('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function backToList() {
    setSelectedPath(null);
    setContent('');
    setDraft('');
  }

  const isEmpty = files.length === 0 || files.every((f) => f.path === 'introduce.md');
  const scanInFlight = scanBusy || externalScanRunning;
  // Both Max and ApiKey modes can drive a real scan now — Max via the CLI's
  // own Read/Write/Glob tools (see ClaudeCliBridge), ApiKey via the agent's
  // server-side tool dispatcher.
  const showScan = agentMode === 'Max' || agentMode === 'ApiKey';

  // Card view (no file selected) — show toolbar + add-form + list/empty.
  // Reader view (file selected) — single pane, full panel width.
  return (
    <div className="agent-memory">
      {!selectedPath && (
        <>
          <div className="agent-memory-toolbar">
            <div className="agent-memory-toolbar-meta" title={root}>
              <span className="agent-memory-toolbar-label">memory</span>
              <code className="agent-memory-toolbar-root">{shorten(root)}</code>
            </div>
            <button
              type="button"
              className="agent-memory-iconbtn"
              onClick={refresh}
              disabled={loading}
              title="Refresh"
              aria-label="refresh"
            >↻</button>
            <button
              type="button"
              className="agent-memory-iconbtn"
              onClick={() => { setAdding(true); setNewPath(''); setNewContent(''); }}
              title="Add a memory file"
              aria-label="add"
            >+</button>
            {showScan && (
              <button
                type="button"
                className="agent-memory-scan-btn"
                onClick={onScan}
                disabled={scanInFlight}
                title={isEmpty ? 'Scan project to populate memory' : 'Re-scan to refresh'}
              >
                {scanInFlight ? 'Scanning…' : (isEmpty ? '✦ Scan' : '✦ Re-scan')}
              </button>
            )}
          </div>

          {adding && (
            <div className="agent-memory-add">
              <div className="agent-memory-add-row">
                <span className="agent-memory-add-label">path</span>
                <input
                  autoFocus
                  className="agent-memory-add-input"
                  placeholder="auth-flow.md"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newPath.trim()) createFile(); }}
                />
              </div>
              <textarea
                className="agent-memory-add-textarea"
                placeholder="optional content — leave blank to start with an empty file"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={4}
              />
              <div className="agent-memory-add-actions">
                <button type="button" className="link-btn" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
                <button type="button" className="agent-memory-scan-btn" onClick={createFile} disabled={!newPath.trim()}>Create</button>
              </div>
            </div>
          )}

          {isEmpty && (() => {
            const maxNoOp =
              agentMode === 'Max' &&
              lastScan?.status === 'succeeded' &&
              (lastScan.totals?.toolCalls ?? 0) === 0 &&
              (lastScan.totals?.dollars ?? 0) === 0;

            return (
              <div className="agent-memory-empty">
                <div className="agent-memory-empty-title">
                  {maxNoOp ? 'Last scan produced no files' : 'No memory yet'}
                </div>
                {maxNoOp ? (
                  <>
                    <p className="agent-memory-empty-body">
                      Scan finished but didn't write any memory. Try again, or add a file
                      manually below.
                    </p>
                    <div className="agent-memory-empty-actions">
                      <button
                        type="button"
                        className="agent-memory-scan-btn is-primary"
                        onClick={onScan}
                        disabled={scanInFlight}
                      >{scanInFlight ? 'Scanning…' : '✦ Try scan again'}</button>
                      <button
                        type="button"
                        className="agent-memory-scan-btn"
                        onClick={() => { setAdding(true); setNewPath(''); setNewContent(''); }}
                      >+ Add file manually</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="agent-memory-empty-body">
                      Run a scan so the agent can walk every endpoint, classify components,
                      and write per-area summaries here. Files travel with your repo under{' '}
                      <code>{shorten(root)}</code>. Estimated cost: $1–2 depending on project size.
                    </p>
                    <button
                      type="button"
                      className="agent-memory-scan-btn is-primary"
                      onClick={onScan}
                      disabled={scanInFlight}
                    >
                      {scanInFlight ? 'Scanning…' : '✦ Start scan'}
                    </button>
                  </>
                )}
              </div>
            );
          })()}

          {!isEmpty && (
            <ul className="memory-cards" role="list">
              {files.map((f) => (
                <li key={f.path} className="memory-card" onClick={() => openFile(f.path)}>
                  <div className="memory-card-head">
                    <span className="memory-card-icon" aria-hidden="true">▤</span>
                    <span className="memory-card-name">{f.path.split('/').pop()}</span>
                    <span className="memory-card-time">{relativeTime(f.updatedAt)}</span>
                  </div>
                  <div className="memory-card-preview">
                    {(previews[f.path] || '').slice(0, 220) || <span className="muted small">(empty)</span>}
                  </div>
                  <div className="memory-card-foot muted small">
                    <code>{f.path}</code>
                    <span>{formatBytes(f.bytes)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {selectedPath && (() => {
        const dirty = draft !== content;
        return (
          <div className="memory-reader">
            <div className="memory-reader-head">
              <button
                type="button"
                className="memory-reader-back"
                onClick={backToList}
                aria-label="back to list"
                title={dirty ? 'Discard changes and go back' : 'Back to list'}
              >← Memory</button>
              <code className="memory-reader-path">{selectedPath}</code>
              <span className="agent-memory-spacer" />
              <button className="link-btn" onClick={deleteCurrent}>Delete</button>
              {dirty && (
                <>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setDraft(content)}
                    title="Revert unsaved changes"
                  >Revert</button>
                  <button
                    type="button"
                    className="memory-reader-save"
                    onClick={saveDraft}
                  >Save</button>
                </>
              )}
              {!dirty && (
                <span className="memory-reader-status muted small">saved</span>
              )}
            </div>
            <textarea
              className="memory-reader-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </div>
        );
      })()}

      {error && <div className="agent-memory-error">{error}</div>}
    </div>
  );
}

function shorten(p: string): string {
  if (p.length <= 60) return p;
  return '…' + p.slice(-57);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
