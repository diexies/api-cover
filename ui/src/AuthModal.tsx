import { useEffect, useState } from 'react';
import type { AuthConfig, AuthType, ApiKeyLocation } from './auth';

interface Props {
  initial: AuthConfig;
  onSave: (cfg: AuthConfig) => void;
  onClose: () => void;
}

/**
 * Slide-in-from-the-right modal that lets the user pick an auth strategy and provide
 * credentials. Pure form — persistence is the caller's responsibility (App owns the
 * localStorage round-trip via the auth module).
 */
export function AuthModal({ initial, onSave, onClose }: Props) {
  const [cfg, setCfg] = useState<AuthConfig>(initial);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function setType(type: AuthType) {
    if (type === 'bearer' && !cfg.bearer) setCfg({ ...cfg, type, bearer: { token: '' } });
    else if (type === 'apiKey' && !cfg.apiKey) setCfg({ ...cfg, type, apiKey: { name: 'X-API-Key', value: '', location: 'header' } });
    else if (type === 'basic' && !cfg.basic) setCfg({ ...cfg, type, basic: { username: '', password: '' } });
    else setCfg({ ...cfg, type });
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Authorization">
        <div className="modal-head">
          <h3>Authorization</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <p className="muted small">
          Credentials attach to every HTTP request the engine emits during a run. Stored locally in
          your browser; never persisted on the server.
        </p>

        <div className="auth-types">
          {(['none', 'bearer', 'apiKey', 'basic'] as AuthType[]).map((t) => (
            <button
              key={t}
              className={`auth-type ${cfg.type === t ? 'active' : ''}`}
              onClick={() => setType(t)}
            >
              {labelFor(t)}
            </button>
          ))}
        </div>

        {cfg.type === 'bearer' && (
          <div className="auth-form">
            <label className="form-row stacked">
              <span className="form-label">Token</span>
              <input
                className="form-input"
                value={cfg.bearer?.token ?? ''}
                onChange={(e) => setCfg({ ...cfg, bearer: { token: e.target.value } })}
                placeholder="eyJhbGciOiJI…"
                autoFocus
              />
            </label>
            <div className="muted small">→ <code>Authorization: Bearer &lt;token&gt;</code></div>
          </div>
        )}

        {cfg.type === 'apiKey' && (
          <div className="auth-form">
            <label className="form-row stacked">
              <span className="form-label">Header / param name</span>
              <input
                className="form-input"
                value={cfg.apiKey?.name ?? ''}
                onChange={(e) => setCfg({ ...cfg, apiKey: { ...cfg.apiKey!, name: e.target.value } })}
                placeholder="X-API-Key"
              />
            </label>
            <label className="form-row stacked">
              <span className="form-label">Value</span>
              <input
                className="form-input"
                value={cfg.apiKey?.value ?? ''}
                onChange={(e) => setCfg({ ...cfg, apiKey: { ...cfg.apiKey!, value: e.target.value } })}
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
                      checked={cfg.apiKey?.location === loc}
                      onChange={() => setCfg({ ...cfg, apiKey: { ...cfg.apiKey!, location: loc } })}
                    />
                    {loc}
                  </label>
                ))}
              </div>
            </label>
            <div className="muted small">
              → {cfg.apiKey?.location === 'query'
                ? <>URL <code>?{cfg.apiKey?.name || 'name'}=&lt;value&gt;</code></>
                : <>header <code>{cfg.apiKey?.name || 'name'}: &lt;value&gt;</code></>}
            </div>
          </div>
        )}

        {cfg.type === 'basic' && (
          <div className="auth-form">
            <label className="form-row stacked">
              <span className="form-label">Username</span>
              <input
                className="form-input"
                value={cfg.basic?.username ?? ''}
                onChange={(e) => setCfg({ ...cfg, basic: { ...cfg.basic!, username: e.target.value } })}
                autoFocus
              />
            </label>
            <label className="form-row stacked">
              <span className="form-label">Password</span>
              <input
                className="form-input"
                type="password"
                value={cfg.basic?.password ?? ''}
                onChange={(e) => setCfg({ ...cfg, basic: { ...cfg.basic!, password: e.target.value } })}
              />
            </label>
            <div className="muted small">→ <code>Authorization: Basic &lt;base64&gt;</code></div>
          </div>
        )}

        {cfg.type === 'none' && (
          <div className="muted">No credentials will be attached to runs.</div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSave(cfg); onClose(); }}>Save</button>
        </div>
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
