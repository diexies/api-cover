import { useEffect, useState } from 'react';
import {
  type AgentCredentials,
  type AgentStatus,
  deleteAgentCredentials,
  getAgentCredentials,
  saveAgentCredentials,
  testAgentCredentials,
} from './api';

interface Props {
  status: AgentStatus;
  onChanged?: () => void;
}

type Mode = 'Disabled' | 'ApiKey' | 'Max';

/**
 * "AI Agent" tab inside GlobalSettingsModal. The user picks a mode (Max if available,
 * else API key) and configures a per-key daily dollar cap. The plaintext key never
 * leaves the textarea — the server stores it encrypted via Data Protection.
 */
export function AgentSettingsTab({ status, onChanged }: Props) {
  const [credentials, setCredentials] = useState<AgentCredentials | null>(null);
  const [mode, setMode] = useState<Mode>('Disabled');
  const [apiKey, setApiKey] = useState('');
  const [dailyCap, setDailyCap] = useState<number>(5);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { reload(); }, []);

  async function reload() {
    try {
      const c = await getAgentCredentials();
      setCredentials(c);
      setMode(c.mode);
      setDailyCap(c.dailyDollarCap ?? 5);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setError(null);
    setTestResult(null);
    setSaving(true);
    try {
      if (mode === 'Disabled') {
        await deleteAgentCredentials();
      } else if (mode === 'Max') {
        await saveAgentCredentials({ mode: 'Max' });
      } else {
        if (!apiKey && !credentials?.hasApiKey) {
          throw new Error('Enter an API key.');
        }
        await saveAgentCredentials({
          mode: 'ApiKey',
          apiKey: apiKey || undefined,
          dailyDollarCap: dailyCap,
        });
        setApiKey('');
      }
      await reload();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testAgentCredentials();
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const maxAvailable = status.allowMaxSubscription && status.maxDetected;
  const apiKeyAllowed = status.allowApiKey;

  return (
    <div className="agent-settings">
      <p className="muted small">
        The agent reads your live API discovery to answer questions. Pick how it authenticates
        with Anthropic. The API key is encrypted at rest with ASP.NET Data Protection — the UI
        only ever sees the last four characters once stored.
      </p>

      <div className="auth-types">
        <button
          className={`auth-type ${mode === 'Disabled' ? 'active' : ''}`}
          onClick={() => setMode('Disabled')}
        >Disabled</button>
        <button
          className={`auth-type ${mode === 'Max' ? 'active' : ''}${maxAvailable ? '' : ' disabled'}`}
          onClick={() => maxAvailable && setMode('Max')}
          disabled={!maxAvailable}
          title={maxAvailable ? `claude CLI ${status.maxVersion ?? ''}` : 'claude CLI not detected on server PATH'}
        >Max subscription</button>
        <button
          className={`auth-type ${mode === 'ApiKey' ? 'active' : ''}${apiKeyAllowed ? '' : ' disabled'}`}
          onClick={() => apiKeyAllowed && setMode('ApiKey')}
          disabled={!apiKeyAllowed}
        >API key</button>
      </div>

      {mode === 'Max' && (
        <div className="auth-form">
          <p>
            {maxAvailable
              ? <>Detected <code>claude</code> CLI{status.maxVersion ? <> ({status.maxVersion})</> : null}. The agent will spawn it as a child process and use your Max quota.</>
              : <>The <code>claude</code> CLI is not on the server's PATH. Install Claude Code on the host running APICover, or switch to API-key mode.</>}
          </p>
          <p className="muted small">
            Max mode does not support tool calls in M1 — for richer "scan project" runs, use API-key mode.
          </p>
        </div>
      )}

      {mode === 'ApiKey' && (
        <div className="auth-form">
          <label className="form-row stacked">
            <span className="form-label">API key</span>
            <input
              className="form-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={credentials?.hasApiKey ? `••••••${credentials.lastFourChars ?? ''}` : 'sk-ant-…'}
              autoComplete="off"
            />
            {credentials?.hasApiKey && !apiKey && (
              <span className="muted small">Stored. Leave blank to keep the existing key.</span>
            )}
          </label>
          <label className="form-row stacked">
            <span className="form-label">Daily dollar cap</span>
            <input
              className="form-input"
              type="number"
              min={0.5}
              step={0.5}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value))}
            />
            <span className="muted small">
              Hard ceiling on Anthropic spend per day. Combined with global cap{' '}
              {status.globalDailyDollarCap ? `($${status.globalDailyDollarCap.toFixed(2)})` : '(none)'} —
              whichever is lower wins. Resets at 00:00 UTC.
            </span>
          </label>
        </div>
      )}

      {error && <div className="agent-panel-error">{error}</div>}
      {testResult && (
        <div className={testResult.ok ? 'agent-msg-system' : 'agent-panel-error'}>
          {testResult.ok ? '✓ Connection works.' : `✗ ${testResult.error ?? 'Test failed.'}`}
        </div>
      )}

      <div className="modal-foot agent-settings-actions">
        <button className="agent-panel-send-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {credentials?.mode !== 'Disabled' && (
          <button className="link-btn" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
      </div>
    </div>
  );
}
