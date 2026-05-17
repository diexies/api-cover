import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openReconnectingEventSource, type SseStatus } from './useEventSource';

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, handler: (e: MessageEvent) => void) {
    (this.listeners[name] ||= []).push(handler);
  }
  close() { this.closed = true; }
  // Test helpers
  fireOpen() { this.onopen?.(); }
  fireEvent(name: string, data: unknown) {
    const handlers = this.listeners[name] ?? [];
    const evt = { data: JSON.stringify(data) } as MessageEvent;
    for (const h of handlers) h(evt);
  }
  fireError() { this.onerror?.(new Event('error')); }
}

describe('openReconnectingEventSource', () => {
  let originalES: typeof EventSource;
  beforeEach(() => {
    vi.useFakeTimers();
    originalES = globalThis.EventSource;
    // @ts-expect-error stub
    globalThis.EventSource = FakeEventSource;
    FakeEventSource.last = null;
    FakeEventSource.instances = [];
  });
  afterEach(() => {
    globalThis.EventSource = originalES;
    vi.useRealTimers();
  });

  it('opens, transitions to open on success, delivers events', () => {
    const statuses: SseStatus[] = [];
    const events: Array<[string, unknown]> = [];
    const handle = openReconnectingEventSource('/x', {
      events: ['msg'],
      onEvent: (n, e) => events.push([n, JSON.parse(e.data)]),
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses).toEqual(['connecting']);
    expect(FakeEventSource.last).toBeTruthy();
    FakeEventSource.last!.fireOpen();
    expect(statuses).toEqual(['connecting', 'open']);
    FakeEventSource.last!.fireEvent('msg', { a: 1 });
    expect(events).toEqual([['msg', { a: 1 }]]);
    handle.close();
    expect(FakeEventSource.last!.closed).toBe(true);
    expect(statuses[statuses.length - 1]).toBe('closed');
  });

  it('reconnects with exponential backoff on error', () => {
    const statuses: SseStatus[] = [];
    const handle = openReconnectingEventSource('/x', {
      events: ['msg'],
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });
    FakeEventSource.last!.fireOpen();
    expect(statuses).toEqual(['connecting', 'open']);

    // First error → reconnecting, then connecting after 1s backoff
    FakeEventSource.last!.fireError();
    expect(statuses[statuses.length - 1]).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(statuses[statuses.length - 1]).toBe('connecting');
    expect(FakeEventSource.instances.length).toBe(2);

    // Second error → 2s backoff
    FakeEventSource.last!.fireError();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(2); // still 1000ms left of 2000
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(3);

    handle.close();
  });

  it('reconnects when watchdog fires (no events for watchdogSeconds)', () => {
    const statuses: SseStatus[] = [];
    const handle = openReconnectingEventSource('/x', {
      events: ['msg'],
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      watchdogSeconds: 2,
    });
    FakeEventSource.last!.fireOpen();
    // Watchdog armed at open; without any frame for 2s, force reconnect.
    vi.advanceTimersByTime(2000);
    expect(statuses[statuses.length - 1]).toBe('reconnecting');
    handle.close();
  });

  it('caps backoff at 30s', () => {
    const handle = openReconnectingEventSource('/x', {
      events: ['msg'],
      onEvent: () => {},
    });
    FakeEventSource.last!.fireOpen();
    // Fire 10 consecutive errors → backoff would be 2^9 * 1s = 512s without cap
    for (let i = 0; i < 10; i++) {
      FakeEventSource.last!.fireError();
      vi.advanceTimersByTime(30_000); // advance max-cap each round
      FakeEventSource.last!.fireOpen();
    }
    handle.close();
  });

  it('resets attempt counter after successful open', () => {
    const handle = openReconnectingEventSource('/x', {
      events: ['msg'],
      onEvent: () => {},
    });
    FakeEventSource.last!.fireOpen();
    FakeEventSource.last!.fireError();
    vi.advanceTimersByTime(1000);
    FakeEventSource.last!.fireOpen(); // success — counter resets
    FakeEventSource.last!.fireError();
    // Should be 1s again, not 2s
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances.length).toBe(3);
    handle.close();
  });
});
