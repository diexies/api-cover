/**
 * Per-browser auth config used to attach credentials to every run's HTTP requests.
 * Persisted to localStorage so the user doesn't have to retype their token each session.
 * Stored client-side only — never sent to the backend until run start, and the backend
 * forwards it verbatim on the wire (no logging, no persistence).
 */

export type AuthType = 'none' | 'bearer' | 'apiKey' | 'basic';
export type ApiKeyLocation = 'header' | 'query';

export interface AuthConfig {
  type: AuthType;
  bearer?: { token: string };
  apiKey?: { name: string; value: string; location: ApiKeyLocation };
  basic?: { username: string; password: string };
}

const STORAGE_KEY = 'utopia.inspector.auth';

export function loadAuth(): AuthConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { type: 'none' };
    const parsed = JSON.parse(raw) as AuthConfig;
    if (!parsed.type) return { type: 'none' };
    return parsed;
  } catch {
    return { type: 'none' };
  }
}

export function saveAuth(cfg: AuthConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Build the run-options shape the backend accepts. Returns empty maps when type === 'none'. */
export function authToRunOptions(cfg: AuthConfig): {
  headers?: Record<string, string>;
  queryParameters?: Record<string, string>;
} {
  if (cfg.type === 'bearer' && cfg.bearer?.token) {
    return { headers: { Authorization: `Bearer ${cfg.bearer.token}` } };
  }
  if (cfg.type === 'apiKey' && cfg.apiKey?.name && cfg.apiKey.value) {
    if (cfg.apiKey.location === 'query') {
      return { queryParameters: { [cfg.apiKey.name]: cfg.apiKey.value } };
    }
    return { headers: { [cfg.apiKey.name]: cfg.apiKey.value } };
  }
  if (cfg.type === 'basic' && cfg.basic?.username) {
    const credential = `${cfg.basic.username}:${cfg.basic.password ?? ''}`;
    const encoded = btoa(credential);
    return { headers: { Authorization: `Basic ${encoded}` } };
  }
  return {};
}

export function authSummary(cfg: AuthConfig): string {
  switch (cfg.type) {
    case 'bearer': return cfg.bearer?.token ? 'Bearer ✓' : 'Bearer (empty)';
    case 'apiKey':
      if (!cfg.apiKey?.name || !cfg.apiKey.value) return 'API Key (empty)';
      return `API Key: ${cfg.apiKey.name} (${cfg.apiKey.location})`;
    case 'basic': return cfg.basic?.username ? `Basic: ${cfg.basic.username}` : 'Basic (empty)';
    default: return 'No auth';
  }
}
