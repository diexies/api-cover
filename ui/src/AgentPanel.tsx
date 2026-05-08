import { useEffect, useRef, useState } from 'react';
import {
  type AgentEvent,
  type AgentStatus,
  type SessionDoc,
  getAgentSession,
  getAgentStatus,
  startAgentRun,
  subscribeAgentEvents,
} from './api';
import { AgentMemoryTab } from './AgentMemoryTab';
import { AgentSessionsList } from './AgentSessionsList';
import { AgentTimeline } from './AgentTimeline';

interface Props {
  status: AgentStatus;
  onClose: () => void;
  onOpenSettings: () => void;
  onStatusChanged?: (status: AgentStatus) => void;
}

type Tab = 'chat' | 'memory';

/**
 * Right-docked chat panel for the embedded Claude agent. Live runs and replayed
 * sessions both feed the same {@link AgentTimeline} component — animation kicks
 * in as events arrive. Budget gauge in the header reflects per-run + per-day
 * spend.
 */
export function AgentPanel({ status: initialStatus, onClose, onOpenSettings, onStatusChanged }: Props) {
  const [status, setStatus] = useState<AgentStatus>(initialStatus);
  const ready = status.mode !== 'Disabled' && (status.mode === 'Max' || status.hasApiKey);

  const [tab, setTab] = useState<Tab>('chat');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Live timeline state. activeRunId is set when a run is in flight or replayed.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activePrompt, setActivePrompt] = useState<string>('');
  const [events, setEvents] = useState<AgentEvent[]>([]);

  const [usage, setUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    inRun: number;
    today: number;
    cap?: number;
  }>({ inputTokens: 0, outputTokens: 0, inRun: 0, today: 0, cap: status.dailyDollarCap ?? status.globalDailyDollarCap });
  const [error, setError] = useState<string | null>(null);
  const [budgetExhausted, setBudgetExhausted] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => { unsubRef.current?.(); };
  }, []);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [events]);

  async function refreshStatus() {
    const s = await getAgentStatus();
    if (s) {
      setStatus(s);
      onStatusChanged?.(s);
    }
  }

  function resetTimeline(promptText: string) {
    unsubRef.current?.();
    setEvents([]);
    setError(null);
    setBudgetExhausted(false);
    setUsage((u) => ({ ...u, inRun: 0, inputTokens: 0, outputTokens: 0 }));
    setActivePrompt(promptText);
  }

  async function send() {
    const text = prompt.trim();
    if (!text || busy || !ready || budgetExhausted) return;
    resetTimeline(text);
    setPrompt('');
    setBusy(true);
    try {
      const r = await startAgentRun(text, 'chat');
      setActiveRunId(r.runId);
      unsubRef.current = subscribeAgentEvents(r.runId, onEvent);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function startScan() {
    if (scanBusy || !ready) return;
    resetTimeline('Scan the project and populate memory.');
    setScanBusy(true);
    try {
      const r = await startAgentRun('Scan the project and populate memory.', 'scan');
      setActiveRunId(r.runId);
      unsubRef.current = subscribeAgentEvents(r.runId, onEvent);
    } catch (e) {
      setError((e as Error).message);
      setScanBusy(false);
    }
  }

  function onEvent(evt: AgentEvent) {
    setEvents((prev) => [...prev, evt]);

    if (evt.type === 'UsageUpdate') {
      setUsage({
        inputTokens: evt.inputTokens ?? 0,
        outputTokens: evt.outputTokens ?? 0,
        inRun: evt.dollarsSpentInRun ?? 0,
        today: evt.dollarsSpentToday ?? 0,
        cap: evt.dailyDollarCap ?? undefined,
      });
    } else if (evt.type === 'BudgetExhausted') {
      setBudgetExhausted(true);
      setBusy(false);
      setScanBusy(false);
      unsubRef.current?.();
      refreshStatus();
    } else if (evt.type === 'RunCompleted') {
      setBusy(false);
      setScanBusy(false);
      unsubRef.current?.();
      refreshStatus();
    } else if (evt.type === 'RunFailed') {
      setBusy(false);
      setScanBusy(false);
      unsubRef.current?.();
    }
  }

  async function loadPastSession(id: string) {
    setHistoryOpen(false);
    let doc: SessionDoc | null;
    try {
      doc = await getAgentSession(id);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!doc) return;
    unsubRef.current?.();
    setActiveRunId(doc.id);
    setActivePrompt(doc.prompt);
    setEvents([]);
    // Replay events with a small stagger so animations re-run.
    let i = 0;
    function tick() {
      if (i >= doc!.events.length) return;
      const evt = doc!.events[i++];
      setEvents((prev) => [...prev, evt]);
      const delay = evt.type === 'TextDelta' || evt.type === 'ComposingResponse' ? 8 : 60;
      setTimeout(tick, delay);
    }
    tick();
    setUsage({
      inputTokens: doc.totals.inputTokens,
      outputTokens: doc.totals.outputTokens,
      inRun: doc.totals.dollars,
      today: 0,
      cap: status.dailyDollarCap ?? status.globalDailyDollarCap,
    });
  }

  return (
    <div className="agent-panel">
      <div className="agent-panel-head">
        <div className="agent-panel-title">
          <span className="agent-panel-spark">✦</span>
          <span>Claude Agent</span>
          <span className="agent-panel-model muted small">{status.model}</span>
        </div>
        <div className="agent-panel-actions">
          <button
            className={`agent-panel-iconbtn${historyOpen ? ' active' : ''}`}
            title="Run history"
            onClick={() => setHistoryOpen((v) => !v)}
          >🕐</button>
          <button className="agent-panel-iconbtn" title="Toggle raw events" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? '⊟' : '⊞'}
          </button>
          <button className="agent-panel-iconbtn" title="Agent settings" onClick={onOpenSettings}>⚙</button>
          <button className="agent-panel-iconbtn" title="Close" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="agent-panel-meter">
        <div className="agent-panel-meter-row">
          <span className="agent-panel-meter-label">today</span>
          <span className="agent-panel-meter-value">{formatDollars(usage.today)} / {formatDollars(usage.cap)}</span>
        </div>
        <div className="agent-panel-meter-bar">
          <div
            className="agent-panel-meter-fill"
            style={{ width: `${barPct(usage.today, usage.cap)}%` }}
          />
        </div>
        <div className="agent-panel-meter-row small muted">
          <span>this run</span>
          <span>{formatDollars(usage.inRun)} · {(usage.inputTokens + usage.outputTokens).toLocaleString()} tok</span>
        </div>
      </div>

      <div className="agent-panel-tabs">
        <button className={`agent-panel-tab${tab === 'chat' ? ' active' : ''}`} onClick={() => setTab('chat')}>Chat</button>
        <button className={`agent-panel-tab${tab === 'memory' ? ' active' : ''}`} onClick={() => setTab('memory')}>
          Memory{status.memoryFileCount > 1 ? ` (${status.memoryFileCount - 1})` : ''}
        </button>
      </div>

      {historyOpen && (
        <AgentSessionsList
          activeId={activeRunId}
          onPick={loadPastSession}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {tab === 'memory' && (
        <AgentMemoryTab onScan={startScan} scanBusy={scanBusy} />
      )}

      {tab === 'chat' && (
      <>
      <div className="agent-panel-transcript" ref={timelineRef}>
        {!ready && (
          <div className="agent-panel-empty">
            <p>Configure AI Agent in <button className="link-btn" onClick={onOpenSettings}>Settings</button> to start.</p>
            <p className="muted small">
              {status.allowMaxSubscription && status.maxDetected
                ? <>Max subscription detected ({status.maxVersion}) — pick "Max" mode to use it without an API key.</>
                : <>{status.allowMaxSubscription ? 'Max not detected — ' : ''}Use an Anthropic API key with a daily cap.</>}
            </p>
          </div>
        )}
        {ready && events.length === 0 && (
          <div className="agent-panel-empty">
            <p>Ask anything about this API.</p>
            <ul className="agent-panel-suggestions">
              <li><button className="link-btn" onClick={() => setPrompt('What endpoints does this API expose? Group by area.')}>What endpoints does this API expose?</button></li>
              <li><button className="link-btn" onClick={() => setPrompt('Walk me through the most likely user journey this API supports.')}>Walk me through the most likely user journey.</button></li>
              <li><button className="link-btn" onClick={() => setPrompt('Are there any deprecated endpoints I should avoid?')}>Are any endpoints deprecated?</button></li>
            </ul>
          </div>
        )}
        {ready && events.length > 0 && (
          <AgentTimeline events={events} prompt={activePrompt} showRaw={showRaw} />
        )}
        {error && <div className="agent-panel-error">{error}</div>}
      </div>

      <div className="agent-panel-input">
        <textarea
          className="agent-panel-textarea"
          placeholder={ready ? 'Ask about the API…' : 'Configure agent in Settings →'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={!ready || busy || budgetExhausted}
          rows={3}
        />
        <div className="agent-panel-input-foot">
          <span className="muted small">⌘↵ to send · shift+↵ for newline</span>
          <button
            className="agent-panel-send-btn"
            onClick={send}
            disabled={!ready || busy || budgetExhausted || prompt.trim().length === 0}
          >
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function formatDollars(n: number | undefined | null): string {
  if (n === null || n === undefined) return '∞';
  return `$${n.toFixed(2)}`;
}

function barPct(spent: number | undefined, cap: number | undefined): number {
  if (!cap || cap <= 0 || !spent) return 0;
  return Math.min(100, Math.max(0, (spent / cap) * 100));
}
