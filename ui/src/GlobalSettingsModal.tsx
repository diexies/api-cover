import { useEffect, useState } from 'react';
import type { AuthConfig, AuthType, ApiKeyLocation } from './auth';

interface Props {
  initialAuth: AuthConfig;
  onSaveAuth: (cfg: AuthConfig) => void;
  onClose: () => void;
}

type Tab = 'auth' | 'settings';

/**
 * Workspace-level centred modal. Closing (backdrop click / Escape / explicit close button)
 * auto-persists the current auth state — there are no Save/Cancel buttons.
 */
export function GlobalSettingsModal({ initialAuth, onSaveAuth, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('auth');
  const [auth, setAuth] = useState<AuthConfig>(initialAuth);

  // Persist on every change so closing always reflects the latest state.
  useEffect(() => {
    onSaveAuth(auth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

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
      <div className="modal-centered" role="dialog" aria-label="Global settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Global Settings</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="tabs" role="tablist">
          <button className={tab === 'auth' ? 'tab active' : 'tab'} onClick={() => setTab('auth')}>Auth</button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>Settings</button>
        </div>

        {tab === 'auth' && (
          <div className="tab-pane">
            <p className="muted small">
              Credentials attach to every HTTP request the engine emits during a run. Stored locally in your
              browser; never persisted on the server.
            </p>
            <div className="auth-types">
              {(['none', 'bearer', 'apiKey', 'basic'] as AuthType[]).map((t) => (
                <button
                  key={t}
                  className={`auth-type ${auth.type === t ? 'active' : ''}`}
                  onClick={() => setType(t)}
                >
                  {labelFor(t)}
                </button>
              ))}
            </div>

            {auth.type === 'bearer' && (
              <div className="auth-form">
                <label className="form-row stacked">
                  <span className="form-label">Token</span>
                  <input
                    className="form-input"
                    value={auth.bearer?.token ?? ''}
                    onChange={(e) => setAuth({ ...auth, bearer: { token: e.target.value } })}
                    placeholder="eyJhbGciOiJI…"
                    autoFocus
                  />
                </label>
                <div className="muted small">→ <code>Authorization: Bearer &lt;token&gt;</code></div>
              </div>
            )}

            {auth.type === 'apiKey' && (
              <div className="auth-form">
                <label className="form-row stacked">
                  <span className="form-label">Header / param name</span>
                  <input
                    className="form-input"
                    value={auth.apiKey?.name ?? ''}
                    onChange={(e) => setAuth({ ...auth, apiKey: { ...auth.apiKey!, name: e.target.value } })}
                    placeholder="X-API-Key"
                  />
                </label>
                <label className="form-row stacked">
                  <span className="form-label">Value</span>
                  <input
                    className="form-input"
                    value={auth.apiKey?.value ?? ''}
                    onChange={(e) => setAuth({ ...auth, apiKey: { ...auth.apiKey!, value: e.target.value } })}
                    placeholder="sk-…"
                  />
                </label>
                <label className="form-row stacked">
                  <span className="form-label">Send in</span>
                  <div className="auth-radio">
                    {(['header', 'query'] as ApiKeyLocation[]).map((loc) => (
                      <label key={loc}>
                        <input
                          type="radio"
                          checked={auth.apiKey?.location === loc}
                          onChange={() => setAuth({ ...auth, apiKey: { ...auth.apiKey!, location: loc } })}
                        />
                        {loc}
                      </label>
                    ))}
                  </div>
                </label>
                <div className="muted small">
                  → {auth.apiKey?.location === 'query'
                    ? <>URL <code>?{auth.apiKey?.name || 'name'}=&lt;value&gt;</code></>
                    : <>header <code>{auth.apiKey?.name || 'name'}: &lt;value&gt;</code></>}
                </div>
              </div>
            )}

            {auth.type === 'basic' && (
              <div className="auth-form">
                <label className="form-row stacked">
                  <span className="form-label">Username</span>
                  <input
                    className="form-input"
                    value={auth.basic?.username ?? ''}
                    onChange={(e) => setAuth({ ...auth, basic: { ...auth.basic!, username: e.target.value } })}
                    autoFocus
                  />
                </label>
                <label className="form-row stacked">
                  <span className="form-label">Password</span>
                  <input
                    className="form-input"
                    type="password"
                    value={auth.basic?.password ?? ''}
                    onChange={(e) => setAuth({ ...auth, basic: { ...auth.basic!, password: e.target.value } })}
                  />
                </label>
                <div className="muted small">→ <code>Authorization: Basic &lt;base64&gt;</code></div>
              </div>
            )}

            {auth.type === 'none' && (
              <div className="muted">No credentials will be attached to runs.</div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="tab-pane">
            <div className="muted small">workspace defaults · coming soon</div>
          </div>
        )}

        <div className="muted small modal-foot">changes auto-save · click outside or press Esc to close</div>
      </div>
    </>
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
