import { useEffect, useState } from 'react';
import {
  type MemoryEntry,
  deleteMemoryFile,
  listMemory,
  readMemoryFile,
  writeMemoryFile,
} from './api';

interface Props {
  onScan: () => void;
  scanBusy: boolean;
}

/**
 * Memory tab inside AgentPanel. Tree on the left, content on the right.
 * Manual edit allowed — user can correct agent mistakes / pre-seed knowledge.
 */
export function AgentMemoryTab({ onScan, scanBusy }: Props) {
  const [files, setFiles] = useState<MemoryEntry[]>([]);
  const [root, setRoot] = useState<string>('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    setLoading(true);
    try {
      const r = await listMemory();
      setFiles(r.files);
      setRoot(r.root);
      if (r.files.length > 0 && !selectedPath) {
        const introduce = r.files.find((f) => f.path === 'introduce.md');
        const first = introduce ?? r.files[0];
        await openFile(first.path);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string) {
    setSelectedPath(path);
    setEditing(false);
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
      setEditing(false);
      await refresh();
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

  const tree = groupByDir(files);
  const isEmpty = files.length === 0 || files.every((f) => f.path === 'introduce.md');

  return (
    <div className="agent-memory">
      <div className="agent-memory-toolbar">
        <span className="muted small" title={root}>root: <code>{shorten(root)}</code></span>
        <span className="agent-memory-spacer" />
        <button className="link-btn" onClick={refresh} disabled={loading}>Refresh</button>
        <button className="agent-panel-send-btn" onClick={onScan} disabled={scanBusy}>
          {scanBusy ? 'Scanning…' : (isEmpty ? 'Scan project' : 'Re-scan')}
        </button>
      </div>

      {isEmpty && (
        <div className="agent-memory-empty">
          <p><strong>No memory yet.</strong></p>
          <p className="muted small">
            Run a scan to let the agent walk every endpoint, classify components,
            and write per-area summaries here. Travels with your repo via{' '}
            <code>{shorten(root)}</code>. Estimated cost: $1–2 depending on project size.
          </p>
        </div>
      )}

      {!isEmpty && (
        <div className="agent-memory-body">
          <div className="agent-memory-tree">
            {tree.map((group) => (
              <div key={group.dir} className="agent-memory-group">
                {group.dir && <div className="agent-memory-group-head">{group.dir}/</div>}
                <ul>
                  {group.files.map((f) => (
                    <li
                      key={f.path}
                      className={f.path === selectedPath ? 'selected' : ''}
                      onClick={() => openFile(f.path)}
                      title={`${f.bytes} bytes · ${new Date(f.updatedAt).toLocaleString()}`}
                    >
                      {f.path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="agent-memory-content">
            {!selectedPath && <div className="muted small">Pick a file →</div>}
            {selectedPath && (
              <>
                <div className="agent-memory-content-head">
                  <code>{selectedPath}</code>
                  <span className="agent-memory-spacer" />
                  {!editing && (
                    <>
                      <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>
                      <button className="link-btn" onClick={deleteCurrent}>Delete</button>
                    </>
                  )}
                  {editing && (
                    <>
                      <button className="link-btn" onClick={() => { setEditing(false); setDraft(content); }}>Cancel</button>
                      <button className="agent-panel-send-btn" onClick={saveDraft}>Save</button>
                    </>
                  )}
                </div>
                {!editing && <pre className="agent-memory-render">{content || '(empty)'}</pre>}
                {editing && (
                  <textarea
                    className="agent-memory-editor"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="agent-panel-error">{error}</div>}
    </div>
  );
}

function groupByDir(files: MemoryEntry[]): { dir: string; files: MemoryEntry[] }[] {
  const map = new Map<string, MemoryEntry[]>();
  for (const f of files) {
    const lastSlash = f.path.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : f.path.slice(0, lastSlash);
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir)!.push(f);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => ({ dir, files }));
}

function shorten(p: string): string {
  if (p.length <= 60) return p;
  return '…' + p.slice(-57);
}
