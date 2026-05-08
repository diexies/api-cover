import { useMemo } from 'react';
import type { AgentEvent } from './api';
import { eventDisplay } from './AgentEventDisplay';

interface Props {
  events: AgentEvent[];
  /** Set true to surface the raw stream (TextDelta, ToolCallStarted/Completed, UsageUpdate). */
  showRaw?: boolean;
  /** Title for the user prompt that started this timeline (rendered above). */
  prompt?: string;
}

/**
 * Renders the agent's event log as an animated vertical timeline. Each event maps
 * to a row via the {@link eventDisplay} table. Live runs and replayed sessions
 * use the same component — animation kicks in on first mount of each row.
 */
export function AgentTimeline({ events, showRaw, prompt }: Props) {
  const rows = useMemo(() => {
    const out: AgentEvent[] = [];
    let composingBuffer: string | null = null;
    for (const evt of events) {
      const display = eventDisplay[evt.type];
      if (!display) continue;
      if (display.hidden && !showRaw) continue;
      // Coalesce successive ComposingResponse deltas into one row whose text grows.
      if (evt.type === 'ComposingResponse') {
        composingBuffer = (composingBuffer ?? '') + (evt.summary ?? '');
        const last = out[out.length - 1];
        if (last && last.type === 'ComposingResponse') {
          out[out.length - 1] = { ...last, summary: composingBuffer };
          continue;
        }
        out.push({ ...evt, summary: composingBuffer });
        continue;
      }
      composingBuffer = null;
      out.push(evt);
    }
    return out;
  }, [events, showRaw]);

  // A categorised work event is "running" until the next iteration's tool starts
  // — but in practice each tool dispatch is synchronous from the timeline's view
  // (started → completed back-to-back). We highlight the latest non-final row as
  // the current step to give visual feedback during longer runs.
  const lastInteractiveIdx = (() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = rows[i].type;
      if (t === 'AssistantMessage' || t === 'RunCompleted' || t === 'RunFailed' || t === 'BudgetExhausted') {
        return -1;
      }
      if (t !== 'UsageUpdate' && t !== 'TextDelta') return i;
    }
    return -1;
  })();

  return (
    <div className="agent-timeline">
      {prompt && (
        <div className="agent-timeline-prompt">
          <span className="agent-timeline-prompt-role">you</span>
          <span className="agent-timeline-prompt-text">{prompt}</span>
        </div>
      )}
      <ol className="agent-timeline-rows">
        {rows.map((evt, idx) => {
          const display = eventDisplay[evt.type];
          const label = display.label(evt);
          const isCurrent = idx === lastInteractiveIdx;
          const classes = [
            'agent-timeline-row',
            `tone-${display.tone}`,
            display.animation ? `anim-${display.animation}` : '',
            isCurrent ? 'is-current' : '',
            evt.type === 'AssistantMessage' ? 'is-final' : '',
          ].filter(Boolean).join(' ');
          return (
            <li key={`${evt.type}-${idx}-${evt.timestamp}`} className={classes}>
              <span className="agent-timeline-icon" aria-hidden="true">{display.icon}</span>
              <div className="agent-timeline-body">
                {evt.type === 'AssistantMessage'
                  ? <pre className="agent-timeline-final-text">{label}</pre>
                  : <span className="agent-timeline-label">{label}</span>}
                {evt.durationMs !== undefined && evt.durationMs > 30 && (
                  <span className="agent-timeline-duration">{evt.durationMs} ms</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
