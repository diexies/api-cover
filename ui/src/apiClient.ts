/**
 * Centralized fetch wrapper for APICover UI.
 *
 * Features:
 *  - Request interceptors for header injection (auth, correlation, locale).
 *  - Exponential-backoff retry on 5xx + network errors (idempotent methods only by default).
 *  - AbortController plumbing.
 *  - Typed JSON parsing helpers.
 *
 * Designed to be a strict superset of `fetch`. Plain `fetch(url, init)` migrations should be
 * mostly drop-in by replacing with `apiFetch(url, init)`.
 */

export type RequestInterceptor = (input: RequestInfo | URL, init: RequestInit) => RequestInit | Promise<RequestInit>;

const interceptors: RequestInterceptor[] = [];

export function addRequestInterceptor(fn: RequestInterceptor): () => void {
  interceptors.push(fn);
  return () => {
    const idx = interceptors.indexOf(fn);
    if (idx >= 0) interceptors.splice(idx, 1);
  };
}

export interface ApiFetchOptions extends RequestInit {
  /** Max retries (default 0 for non-idempotent, 2 for GET/HEAD). */
  retry?: number;
  /** Base backoff in ms (default 250). Doubled per attempt. */
  retryDelayMs?: number;
}

function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}

function shouldRetry(res: Response | null, attempt: number, max: number): boolean {
  if (attempt >= max) return false;
  if (res === null) return true; // network error
  if (res.status >= 500 && res.status <= 599) return true;
  if (res.status === 429) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function apiFetch(input: RequestInfo | URL, init: ApiFetchOptions = {}): Promise<Response> {
  const { retry, retryDelayMs, ...rest } = init;
  const max = retry ?? (isIdempotent(rest.method) ? 2 : 0);
  const baseDelay = retryDelayMs ?? 250;

  let finalInit: RequestInit = rest;
  for (const ic of interceptors) {
    finalInit = await ic(input, finalInit);
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res: Response | null = null;
    let lastErr: unknown = null;
    try {
      res = await fetch(input, finalInit);
    } catch (e) {
      lastErr = e;
    }
    if (res && (res.status < 500 || res.status === 501)) return res;
    if (!shouldRetry(res, attempt, max)) {
      if (res) return res;
      throw lastErr ?? new Error('Network error');
    }
    const delay = baseDelay * Math.pow(2, attempt);
    await sleep(delay);
    attempt++;
  }
}

export async function apiJson<T>(input: RequestInfo | URL, init: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(input, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Builtin auth interceptor — reads from localStorage `apicover.bearerToken` and attaches as
 * Authorization header. Call once at app boot; safe to call multiple times (idempotent).
 */
let authInterceptorRegistered = false;
export function registerLocalStorageBearerInterceptor(): void {
  if (authInterceptorRegistered) return;
  authInterceptorRegistered = true;
  addRequestInterceptor((_input, init) => {
    if (typeof window === 'undefined') return init;
    const token = window.localStorage?.getItem('apicover.bearerToken');
    if (!token) return init;
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
  });
}
