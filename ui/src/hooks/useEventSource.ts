/* eslint-disable @typescript-eslint/no-explicit-any */
// Reconnecting EventSource wrapper. The native EventSource auto-reconnects after 3s on
// network error but exposes no status hook, no heartbeat watchdog, and no backoff. This
// helper wraps it so callers can render "Reconnecting…" banners and recover from silent
// stalls (e.g. a proxy that holds the connection open without delivering bytes).

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseHandle {
  close(): void;
}

export interface SseOptions {
  /** Event names to listen for. Each delivers the raw MessageEvent to onEvent. */
  events: readonly string[];
  /** Handler invoked for every named event received. */
  onEvent: (name: string, event: MessageEvent) => void;
  /** Connection-state change callback. */
  onStatus?: (status: SseStatus) => void;
  /** Raw error callback (forwarded from EventSource.onerror). */
  onError?: (e: Event) => void;
  /** Seconds without any frame (heartbeat or event) before forcing reconnect. Default 25. */
  watchdogSeconds?: number;
}

/**
 * Open an SSE connection that auto-reconnects with exponential backoff (1s → 30s capped),
 * tracks heartbeat liveness with a watchdog timer, and exposes status transitions.
 *
 * Heartbeats are SSE comment lines (`:keepalive\n\n`) emitted by the server every 15s.
 * EventSource ignores them silently — we observe them via the watchdog timer resetting on
 * any successful network read.
 */
export function openReconnectingEventSource(url: string, opts: SseOptions): SseHandle {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const watchdogMs = (opts.watchdogSeconds ?? 25) * 1000;

  function setStatus(s: SseStatus) {
    if (closed) return;
    opts.onStatus?.(s);
  }

  function clearWatchdog() {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function armWatchdog() {
    clearWatchdog();
    watchdog = setTimeout(() => {
      // No event or heartbeat for watchdogMs → consider connection dead and force reconnect.
      if (closed) return;
      cycle();
    }, watchdogMs);
  }

  function attach() {
    es = new EventSource(url);

    es.onopen = () => {
      if (closed) return;
      attempt = 0;
      armWatchdog();
      setStatus('open');
    };

    for (const name of opts.events) {
      es.addEventListener(name, (e) => {
        if (closed) return;
        armWatchdog();
        opts.onEvent(name, e as MessageEvent);
      });
    }

    // Generic message handler — also catches heartbeat-as-message if server ever switches.
    es.addEventListener('message', () => {
      if (closed) return;
      armWatchdog();
    });

    es.onerror = (e) => {
      if (closed) return;
      opts.onError?.(e);
      // EventSource will auto-retry, but we want explicit backoff + status reporting.
      cycle();
    };
  }

  function cycle() {
    if (closed) return;
    clearWatchdog();
    if (es) {
      es.close();
      es = null;
    }
    setStatus('reconnecting');
    attempt++;
    const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    reconnectTimer = setTimeout(() => {
      if (closed) return;
      setStatus('connecting');
      attach();
    }, delayMs);
  }

  setStatus('connecting');
  attach();

  return {
    close() {
      if (closed) return;
      clearWatchdog();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
      // Fire status before flipping the closed flag so the callback runs.
      opts.onStatus?.('closed');
      closed = true;
    },
  };
}
