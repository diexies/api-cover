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
import { AgentMcpTab } from './AgentMcpTab';
import { AgentMemoryTab } from './AgentMemoryTab';
import { AgentSessionsList } from './AgentSessionsList';
import { AgentTimeline } from './AgentTimeline';
import { usePrefs } from './stores/prefs';

interface Props {
  status: AgentStatus;
  /** Optional dismiss handler. When omitted, the panel renders without a close button —
   *  used when the panel is permanently docked into the app shell. */
  onClose?: () => void;
  /** Open global settings. The optional `tab` argument lets callers jump straight
   *  to a specific section (e.g. 'agent' for the configure-agent CTA). */
  onOpenSettings: (tab?: 'auth' | 'agent' | 'settings') => void;
  onStatusChanged?: (status: AgentStatus) => void;
  /** When set, seeds the composer or fires a run on mount (depending on autoStart). */
  initialPrompt?: string;
  /** Optional mode chip (slash-command label) to attach to the started run. */
  initialPromptMode?: string;
  /** When true alongside initialPrompt, immediately runs the prompt without a manual send. */
  autoStart?: boolean;
  /** When true, opens the run-history dropdown on mount (used by "See all" on home). */
  initialHistoryOpen?: boolean;
  /** Called once the panel has consumed initialPrompt so the parent can clear pending state. */
  onPromptConsumed?: () => void;
  /** Fired when a run finishes successfully. Lets the parent react to side effects
   *  (e.g. scenario-generation runs landing a new scenario in the store). */
  onRunCompleted?: (modeLabel: string | null) => void;
}

type Tab = 'chat' | 'memory' | 'mcp';

/**
 * Right-docked chat panel for the embedded Claude agent. Live runs and replayed
 * sessions both feed the same {@link AgentTimeline} component — animation kicks
 * in as events arrive. Budget gauge in the header reflects per-run + per-day
 * spend.
 */
export function AgentPanel({
  status: initialStatus,
  onClose,
  onOpenSettings,
  onStatusChanged,
  initialPrompt,
  initialPromptMode,
  autoStart,
  initialHistoryOpen,
  onPromptConsumed,
  onRunCompleted,
}: Props) {
  const [status, setStatus] = useState<AgentStatus>(initialStatus);
  const ready = status.mode !== 'Disabled' && (status.mode === 'Max' || status.hasApiKey);

  const [tab, setTab] = useState<Tab>('chat');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  // initialHistoryOpen kept for backwards compat — recent list is the default
  // chat surface now, so the prop is effectively a no-op on this build.
  void initialHistoryOpen;

  // Live timeline state. activeRunId is set when a run is in flight or replayed.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activePrompt, setActivePrompt] = useState<string>('');
  const [activeMode, setActiveMode] = useState<string | null>(null);
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
  // When true, the next [events] scroll-effect snaps to the top of the
  // transcript instead of following the tail — used for replays so the
  // user sees the conversation from the beginning rather than a flash
  // mid-scroll.
  const snapToTopRef = useRef(false);

  useEffect(() => {
    return () => { unsubRef.current?.(); };
  }, []);

  useEffect(() => {
    if (!timelineRef.current) return;
    if (snapToTopRef.current) {
      timelineRef.current.scrollTop = 0;
      snapToTopRef.current = false;
    } else {
      // Live runs follow the tail so new events stay visible.
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

  function resetTimeline(promptText: string, modeLabel: string | null) {
    unsubRef.current?.();
    setEvents([]);
    setError(null);
    setBudgetExhausted(false);
    setUsage((u) => ({ ...u, inRun: 0, inputTokens: 0, outputTokens: 0 }));
    setActivePrompt(promptText);
    setActiveMode(modeLabel);
  }

  async function sendText(text: string, modeLabel: string | null = null) {
    const t = text.trim();
    if (!t || busy || !ready || budgetExhausted) return;
    resetTimeline(t, modeLabel);
    setBusy(true);
    // Map UI chip slug → backend AgentRunMode. Slugs come from KNOWN_MODES in
    // Dashboard.tsx.
    const apiMode =
      modeLabel === 'scenario' ? 'scenarioGen' :
      modeLabel === 'discover' ? 'scenarioInfer' :
      'chat';
    try {
      const r = await startAgentRun(t, apiMode);
      setActiveRunId(r.runId);
      unsubRef.current = subscribeAgentEvents(r.runId, onEvent);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }


  // Consume initialPrompt once: auto-start a run when the home composer hands
  // one over. didAutoStart guards against React StrictMode's double-mount in
  // dev so we never fire the same prompt twice. Non-autoStart path is a
  // no-op now that the panel composer is gone — home composer is the only
  // entry point for new chats.
  const didAutoStart = useRef(false);
  useEffect(() => {
    if (!initialPrompt || didAutoStart.current) return;
    didAutoStart.current = true;
    if (autoStart && ready) void sendText(initialPrompt, initialPromptMode ?? null);
    onPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, autoStart, ready]);

  async function startScan() {
    if (scanBusy || !ready) return;
    resetTimeline('Scan the project and populate memory.', 'scan');
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
      onRunCompleted?.(activeMode);
    } else if (evt.type === 'RunFailed') {
      setBusy(false);
      setScanBusy(false);
      unsubRef.current?.();
    }
  }

  async function loadPastSession(id: string) {
    let doc: SessionDoc | null;
    try {
      doc = await getAgentSession(id);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!doc) return;
    unsubRef.current?.();
    // Set the whole transcript at once so the panel renders the full session
    // in place — no upward flash, no incremental jitter. CSS staggered
    // reveal still gives a sense of motion if reduced-motion isn't set.
    snapToTopRef.current = true;
    setActiveRunId(doc.id);
    setActivePrompt(doc.prompt);
    setActiveMode(null);
    setEvents(doc.events);
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
          <span>Agent</span>
          <ModelPicker currentModel={status.model} />
        </div>
        <div className="agent-panel-actions">
          {activeRunId && (
            <button className="agent-panel-iconbtn" title="Toggle raw events" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? '⊟' : '⊞'}
            </button>
          )}
          <button className="agent-panel-iconbtn" title="Agent settings" onClick={() => onOpenSettings('agent')}>⚙</button>
          {onClose && (
            <button className="agent-panel-iconbtn" title="Close" onClick={onClose}>×</button>
          )}
        </div>
      </div>

      {status.mode === 'ApiKey' && (
        <div className="agent-panel-meter">
          {usage.cap != null && usage.cap > 0 ? (
            <>
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
            </>
          ) : (
            <div className="agent-panel-meter-row">
              <span className="agent-panel-meter-label">today</span>
              <span className="agent-panel-meter-value">{formatDollars(usage.today)} <span className="muted small">used · no cap</span></span>
            </div>
          )}
          <div className="agent-panel-meter-row small muted">
            <span>this run</span>
            <span>{formatDollars(usage.inRun)} · {(usage.inputTokens + usage.outputTokens).toLocaleString()} tok</span>
          </div>
        </div>
      )}

      <div className="agent-panel-tabs">
        <button className={`agent-panel-tab${tab === 'chat' ? ' active' : ''}`} onClick={() => setTab('chat')}>Chat</button>
        <button className={`agent-panel-tab${tab === 'memory' ? ' active' : ''}`} onClick={() => setTab('memory')}>
          Memory{status.memoryFileCount > 1 ? ` (${status.memoryFileCount - 1})` : ''}
        </button>
        <button className={`agent-panel-tab${tab === 'mcp' ? ' active' : ''}`} onClick={() => setTab('mcp')}>MCP</button>
      </div>

      {tab === 'memory' && (
        <AgentMemoryTab
          onScan={startScan}
          scanBusy={scanBusy}
          agentMode={status.mode}
          onOpenSettings={onOpenSettings}
        />
      )}

      {tab === 'mcp' && <AgentMcpTab />}

      {tab === 'chat' && !ready && (
        <div className="agent-panel-empty">
          <p>Configure the agent in <button className="link-btn" onClick={() => onOpenSettings('agent')}>Settings</button> to start.</p>
          <p className="muted small">
            {status.allowMaxSubscription && status.maxDetected
              ? <>Max subscription detected ({status.maxVersion}) — pick "Max" mode to use it without an API key.</>
              : <>{status.allowMaxSubscription ? 'Max not detected — ' : ''}Use an Anthropic API key with a daily cap.</>}
          </p>
        </div>
      )}

      {tab === 'chat' && ready && !activeRunId && (
        <div className="agent-panel-recent">
          <div className="agent-panel-recent-hint muted small">
            Start a new chat from the home composer. Past runs replay below.
          </div>
          <AgentSessionsList activeId={null} onPick={loadPastSession} />
        </div>
      )}

      {tab === 'chat' && ready && activeRunId && (
        <>
          <div className="agent-panel-active-head">
            <button
              type="button"
              className="agent-panel-back"
              onClick={() => {
                unsubRef.current?.();
                setActiveRunId(null);
                setEvents([]);
                setError(null);
                setActivePrompt('');
              }}
            >← Recent runs</button>
            {busy && <span className="agent-panel-active-tag">running…</span>}
          </div>
          <div className="agent-panel-transcript" ref={timelineRef}>
            {events.length > 0 && (
              <AgentTimeline events={events} prompt={activePrompt} promptMode={activeMode} showRaw={showRaw} />
            )}
            {error && <div className="agent-panel-error">{error}</div>}
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

/* ─── Model picker ─────────────────────────────────────────────────────
   Inline dropdown beside the agent header. The current backend doesn't
   expose a "switch model" endpoint, so the selection lives client-side
   for now (prefs store) — the underlying CLI still runs whatever the
   host configured. Wire to a backend setter when available. */

interface ModelOption { id: string; label: string; provider: string }

const MODEL_CATALOG: ModelOption[] = [
  { id: 'claude-opus-4-7-20251101',   label: 'Claude Opus 4.7',   provider: 'Anthropic' },
  { id: 'claude-sonnet-4-6-20250929', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',  provider: 'Anthropic' },
  { id: 'gpt-5',                      label: 'GPT-5',             provider: 'OpenAI' },
  { id: 'gpt-5-mini',                 label: 'GPT-5 mini',        provider: 'OpenAI' },
  { id: 'grok-4',                     label: 'Grok 4',            provider: 'xAI' },
];

function ModelPicker({ currentModel }: { currentModel: string }) {
  const [open, setOpen] = useState(false);
  const storedModel = usePrefs((s) => s.agent.model);
  const [selected, setSelected] = useState<string>(storedModel ?? currentModel);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(id: string) {
    setSelected(id);
    usePrefs.getState().set('agent', { model: id });
    setOpen(false);
  }

  // Display label: prefer catalog match for friendliness, fall back to raw id
  // (some CLIs return models that aren't in the static list).
  const match = MODEL_CATALOG.find((m) => m.id === selected);
  const display = match ? match.label : selected;

  return (
    <div className="agent-model" ref={ref}>
      <button
        type="button"
        className="agent-model-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch model"
      >
        <span className="agent-model-name">{display}</span>
        <span className="agent-model-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="agent-model-popup" role="listbox">
          {MODEL_CATALOG.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === selected}
              className={`agent-model-row${m.id === selected ? ' is-selected' : ''}`}
              onClick={() => pick(m.id)}
            >
              <span className="agent-model-row-label">{m.label}</span>
              <span className="agent-model-row-provider">{m.provider}</span>
              <span className="agent-model-row-id">{m.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
