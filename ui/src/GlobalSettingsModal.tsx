import { useEffect, useState } from 'react';
import type { AuthConfig, AuthType, ApiKeyLocation } from './auth';
import { AgentSettingsTab } from './AgentSettingsTab';
import type { AgentStatus } from './api';

interface Props {
  initialAuth: AuthConfig;
  onSaveAuth: (cfg: AuthConfig) => void;
  onClose: () => void;
  agentStatus: AgentStatus | null;
  onAgentChanged?: () => void;
}

type Tab = 'auth' | 'agent' | 'settings';

const TAB_STORAGE_KEY = 'apicover.settingsTab';

function readStoredTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    if (v === 'auth' || v === 'agent' || v === 'settings') return v;
  } catch { /* ignore */ }
  return 'auth';
}

/**
 * Workspace-level centred modal. Closing (backdrop click / Escape / explicit close button)
 * auto-persists the current auth state — there are no Save / Cancel buttons.
 *
 * Active tab is persisted to localStorage so the modal re-opens where the user left it.
 * Callers that want a specific tab on open should write the key before flipping the
 * modal open (App.openGlobalSettings does this).
 */
export function GlobalSettingsModal({ initialAuth, onSaveAuth, onClose, agentStatus, onAgentChanged }: Props) {
  const [tab, setTab] = useState<Tab>(() => readStoredTab());
  const [auth, setAuth] = useState<AuthConfig>(initialAuth);

  // Persist on every change so closing always reflects the latest state.
  useEffect(() => {
    onSaveAuth(auth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  // Persist the active tab so the modal re-opens where the user left it.
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* quota */ }
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function setType(type: AuthType) {
    if (type === 'bearer' && !auth.bearer) setAuth({ ...auth, type, bearer: { token: '' } });
    else if (type === 'apiKey' && !auth.apiKey) setAuth({ ...auth, type, apiKey: { name: 'X-API-Key', value: '', location: 'header' } });
    else if (type === 'basic' && !auth.basic) setAuth({ ...auth, type, basic: { username: '', password: '' } });
    else setAuth({ ...auth, type });
  }

  return (
    <>
      <div className="modal-backdrop blurred" onClick={onClose} />
      <div className="modal-centered global-settings" role="dialog" aria-modal="true" aria-label="Global settings" onClick={(e) => e.stopPropagation()}>
        <header className="gs-head">
          <div className="gs-head-title">
            <h3>Global Settings</h3>
            <p className="gs-head-sub">workspace-wide preferences · auto-saves on change</p>
          </div>
          <button className="gs-close" onClick={onClose} aria-label="close">×</button>
        </header>

        <nav className="gs-tabs" role="tablist">
          <button
            className={`gs-tab${tab === 'auth' ? ' is-active' : ''}`}
            onClick={() => setTab('auth')}
            role="tab"
            aria-selected={tab === 'auth'}
          >Auth</button>
          {agentStatus && (
            <button
              className={`gs-tab${tab === 'agent' ? ' is-active' : ''}`}
              onClick={() => setTab('agent')}
              role="tab"
              aria-selected={tab === 'agent'}
            >AI Agent</button>
          )}
          <button
            className={`gs-tab${tab === 'settings' ? ' is-active' : ''}`}
            onClick={() => setTab('settings')}
            role="tab"
            aria-selected={tab === 'settings'}
          >Workspace</button>
        </nav>

        <div className="gs-pane">
          {tab === 'auth' && <AuthPane auth={auth} setAuth={setAuth} setType={setType} />}
          {tab === 'agent' && agentStatus && (
            <AgentSettingsTab status={agentStatus} onChanged={onAgentChanged} />
          )}
          {tab === 'settings' && <WorkspacePane />}
        </div>

        <footer className="gs-foot">
          changes auto-save · click outside or press <kbd>Esc</kbd> to close
        </footer>
      </div>
    </>
  );
}

/* ─── Auth pane ─────────────────────────────────────────────────────────── */

interface AuthPaneProps {
  auth: AuthConfig;
  setAuth: React.Dispatch<React.SetStateAction<AuthConfig>>;
  setType: (t: AuthType) => void;
}

function AuthPane({ auth, setAuth, setType }: AuthPaneProps) {
  return (
    <div className="gs-form">
      <p className="gs-intro">
        Credentials attach to every HTTP request the engine emits during a run. Stored locally in
        your browser, never persisted on the server.
      </p>

      <div className="gs-segments" role="radiogroup" aria-label="auth type">
        {(['none', 'bearer', 'apiKey', 'basic'] as AuthType[]).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={auth.type === t}
            className={`gs-segment${auth.type === t ? ' is-active' : ''}`}
            onClick={() => setType(t)}
          >
            {labelFor(t)}
          </button>
        ))}
      </div>

      {auth.type === 'bearer' && (
        <div className="gs-fields">
          <Field label="Token">
            <input
              className="gs-field-input"
              value={auth.bearer?.token ?? ''}
              onChange={(e) => setAuth({ ...auth, bearer: { token: e.target.value } })}
              placeholder="eyJhbGciOiJI…"
              autoFocus
            />
            <span className="gs-field-hint">→ <code>Authorization: Bearer &lt;token&gt;</code></span>
          </Field>
        </div>
      )}

      {auth.type === 'apiKey' && (
        <div className="gs-fields">
          <Field label="Header / param name">
            <input
              className="gs-field-input"
              value={auth.apiKey?.name ?? ''}
              onChange={(e) => setAuth({ ...auth, apiKey: { ...auth.apiKey!, name: e.target.value } })}
              placeholder="X-API-Key"
            />
          </Field>
          <Field label="Value">
            <input
              className="gs-field-input"
              value={auth.apiKey?.value ?? ''}
              onChange={(e) => setAuth({ ...auth, apiKey: { ...auth.apiKey!, value: e.target.value } })}
              placeholder="sk-…"
            />
          </Field>
          <Field label="Send in">
            <div className="gs-radio-group">
              {(['header', 'query'] as ApiKeyLocation[]).map((loc) => (
                <label key={loc} className="gs-radio">
                  <input
                    type="radio"
                    checked={auth.apiKey?.location === loc}
                    onChange={() => setAuth({ ...auth, apiKey: { ...auth.apiKey!, location: loc } })}
                  />
                  <span>{loc}</span>
                </label>
              ))}
            </div>
            <span className="gs-field-hint">
              → {auth.apiKey?.location === 'query'
                ? <>URL <code>?{auth.apiKey?.name || 'name'}=&lt;value&gt;</code></>
                : <>header <code>{auth.apiKey?.name || 'name'}: &lt;value&gt;</code></>}
            </span>
          </Field>
        </div>
      )}

      {auth.type === 'basic' && (
        <div className="gs-fields">
          <Field label="Username">
            <input
              className="gs-field-input"
              value={auth.basic?.username ?? ''}
              onChange={(e) => setAuth({ ...auth, basic: { ...auth.basic!, username: e.target.value } })}
              autoFocus
            />
          </Field>
          <Field label="Password">
            <input
              className="gs-field-input"
              type="password"
              value={auth.basic?.password ?? ''}
              onChange={(e) => setAuth({ ...auth, basic: { ...auth.basic!, password: e.target.value } })}
            />
            <span className="gs-field-hint">→ <code>Authorization: Basic &lt;base64&gt;</code></span>
          </Field>
        </div>
      )}

      {auth.type === 'none' && (
        <div className="gs-callout">
          No credentials will be attached to runs. Endpoints that require auth will return 401 / 403.
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="gs-field">
      <span className="gs-field-label">{label}</span>
      {children}
    </label>
  );
}

/* ─── Workspace pane ────────────────────────────────────────────────────── */

function WorkspacePane() {
  return (
    <div className="gs-form">
      <p className="gs-intro">Workspace-level defaults apply to every scenario you run.</p>
      <div className="gs-empty">
        <div className="gs-empty-title">Coming soon</div>
        <ul className="gs-empty-list">
          <li>Default base URL + per-environment overrides</li>
          <li>Run timeout + concurrency caps</li>
          <li>Reusable JSON templates and fixture library</li>
          <li>Scenario import / export</li>
        </ul>
      </div>
    </div>
  );
}

function labelFor(t: AuthType): string {
  switch (t) {
    case 'none': return 'None';
    case 'bearer': return 'Bearer';
    case 'apiKey': return 'API Key';
    case 'basic': return 'Basic';
  }
}
