import { useEffect, useState } from 'react';
import { type SessionSummary, listAgentSessions } from './api';

interface Props {
  onPick: (id: string) => void;
  onClose: () => void;
  activeId: string | null;
}

/**
 * History dropdown — recent sessions. Click loads the full doc into the timeline.
 */
export function AgentSessionsList({ onPick, onClose, activeId }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { reload(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function reload() {
    setLoading(true);
    try {
      const r = await listAgentSessions(50);
      setSessions(r.sessions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="agent-sessions" role="dialog">
      <div className="agent-sessions-head">
        <h4>Recent runs</h4>
        <button className="agent-panel-iconbtn" onClick={onClose} title="Close">×</button>
      </div>
      {loading && <div className="muted small">Loading…</div>}
      {error && <div className="agent-panel-error">{error}</div>}
      {!loading && sessions.length === 0 && (
        <div className="muted small">No past runs yet.</div>
      )}
      <ul className="agent-sessions-list">
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === activeId ? 'active' : ''}
            onClick={() => onPick(s.id)}
          >
            <div className="agent-sessions-prompt">{truncate(s.prompt, 80)}</div>
            <div className="agent-sessions-meta">
              <span className={`agent-sessions-status status-${s.status.toLowerCase()}`}>{s.status}</span>
              <span className="muted small">
                {s.mode} · {s.totals.toolCalls} tools · ${s.totals.dollars.toFixed(3)}
              </span>
              <span className="muted small agent-sessions-time">
                {new Date(s.startedAt).toLocaleString()}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
