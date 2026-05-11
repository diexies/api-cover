import type { AgentEvent, AgentEventType } from './api';

export type EventTone = 'info' | 'work' | 'done' | 'error' | 'final' | 'silent';

export interface EventDisplay {
  icon: string;
  tone: EventTone;
  /** Animation class applied to the timeline row when first rendered. */
  animation: 'pulse' | 'slide' | 'fade' | null;
  label: (event: AgentEvent) => string;
  /** When true the row is hidden in the default timeline view (raw stream events). */
  hidden?: boolean;
}

/**
 * Authoritative render rules — backend AgentEventType union and this table must
 * stay in lock-step. The event's enum value is the only thing the UI keys off.
 */
export const eventDisplay: Record<AgentEventType, EventDisplay> = {
  RunStarted: {
    icon: '▶',
    tone: 'info',
    animation: 'fade',
    label: () => 'Run started',
  },
  Narration: {
    icon: '💭',
    tone: 'info',
    animation: 'slide',
    label: (e) => e.summary?.trim() || 'Thinking…',
  },
  ReadingMemory: {
    icon: '📖',
    tone: 'work',
    animation: 'slide',
    label: (e) => {
      if (e.path) return `Reading memory · ${e.path}`;
      if (typeof e.count === 'number') return `Listing memory · ${e.count} file${e.count === 1 ? '' : 's'}`;
      return 'Reading memory';
    },
  },
  WritingMemory: {
    icon: '✍️',
    tone: 'work',
    animation: 'slide',
    label: (e) => e.path ? `Writing memory · ${e.path}` : 'Writing memory',
  },
  DiscoveringEndpoints: {
    icon: '🔍',
    tone: 'work',
    animation: 'slide',
    label: (e) => {
      const parts: string[] = ['Discovering endpoints'];
      if (e.summary) parts.push(`area: ${e.summary}`);
      if (typeof e.count === 'number') parts.push(`${e.count} found`);
      return parts.join(' · ');
    },
  },
  ExaminingEndpoint: {
    icon: '🔬',
    tone: 'work',
    animation: 'slide',
    label: (e) => e.endpointId ? `Examining ${e.endpointId}` : 'Examining endpoint',
  },
  ToolError: {
    icon: '⚠',
    tone: 'error',
    animation: 'slide',
    label: (e) => e.summary?.trim() ? `Tool error · ${e.toolName ?? ''}: ${truncate(e.summary, 120)}` : `Tool error · ${e.toolName ?? ''}`,
  },
  ComposingResponse: {
    icon: '✏️',
    tone: 'final',
    animation: null,
    label: () => 'Composing response',
  },
  AssistantMessage: {
    icon: '💬',
    tone: 'final',
    animation: 'fade',
    label: (e) => e.summary?.trim() ?? '',
  },
  RunCompleted: {
    icon: '✓',
    tone: 'done',
    animation: 'fade',
    label: () => 'Done',
  },
  RunFailed: {
    icon: '✗',
    tone: 'error',
    animation: 'fade',
    label: (e) => e.error?.trim() ? `Failed · ${truncate(e.error, 200)}` : 'Run failed',
  },
  BudgetExhausted: {
    icon: '🚫',
    tone: 'error',
    animation: 'fade',
    label: (e) => `Daily budget reached · ${formatDollars(e.dollarsSpentToday)} / ${formatDollars(e.dailyDollarCap)}`,
  },
  UsageUpdate: {
    icon: '📊',
    tone: 'silent',
    animation: null,
    label: (e) => `tokens ${(e.inputTokens ?? 0) + (e.outputTokens ?? 0)} · ${formatDollars(e.dollarsSpentInRun)}`,
    hidden: true,
  },
  TextDelta: {
    icon: '·',
    tone: 'silent',
    animation: null,
    label: () => '',
    hidden: true,
  },
  ToolCallStarted: {
    icon: '·',
    tone: 'silent',
    animation: null,
    label: (e) => e.toolName ?? '',
    hidden: true,
  },
  ToolCallCompleted: {
    icon: '·',
    tone: 'silent',
    animation: null,
    label: (e) => e.toolName ?? '',
    hidden: true,
  },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatDollars(n: number | undefined | null): string {
  if (n === null || n === undefined) return '∞';
  return `$${n.toFixed(2)}`;
}
