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
    <div className="gs-form">
      <p className="gs-intro">
        The agent reads your live API discovery to answer questions. Pick how it authenticates
        with Anthropic. The API key is encrypted at rest with ASP.NET Data Protection — the UI
        only ever sees the last four characters once stored.
      </p>

      <div className="gs-segments" role="radiogroup" aria-label="agent mode">
        <button
          type="button" role="radio" aria-checked={mode === 'Disabled'}
          className={`gs-segment${mode === 'Disabled' ? ' is-active' : ''}`}
          onClick={() => setMode('Disabled')}
        >Disabled</button>
        <button
          type="button" role="radio" aria-checked={mode === 'Max'}
          className={`gs-segment${mode === 'Max' ? ' is-active' : ''}`}
          onClick={() => maxAvailable && setMode('Max')}
          disabled={!maxAvailable}
          title={maxAvailable ? `claude CLI ${status.maxVersion ?? ''}` : 'claude CLI not detected on server PATH'}
        >Max subscription</button>
        <button
          type="button" role="radio" aria-checked={mode === 'ApiKey'}
          className={`gs-segment${mode === 'ApiKey' ? ' is-active' : ''}`}
          onClick={() => apiKeyAllowed && setMode('ApiKey')}
          disabled={!apiKeyAllowed}
        >API key</button>
      </div>

      {mode === 'Max' && (
        <div className="gs-callout">
          {maxAvailable
            ? <>Detected <code>claude</code> CLI{status.maxVersion ? <> ({status.maxVersion})</> : null}. The agent will spawn it as a child process and use your Max quota.</>
            : <>The <code>claude</code> CLI is not on the server's PATH. Install Claude Code on the host running APICover, or switch to API-key mode.</>}
          <div className="gs-callout-sub">
            Max mode does not support tool calls in M1 — for richer "scan project" runs, use API-key mode.
          </div>
        </div>
      )}

      {mode === 'ApiKey' && (
        <div className="gs-fields">
          <label className="gs-field">
            <span className="gs-field-label">API key</span>
            <input
              className="gs-field-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={credentials?.hasApiKey ? `••••••${credentials.lastFourChars ?? ''}` : 'sk-ant-…'}
              autoComplete="off"
            />
            {credentials?.hasApiKey && !apiKey && (
              <span className="gs-field-hint">Stored. Leave blank to keep the existing key.</span>
            )}
          </label>
          <label className="gs-field">
            <span className="gs-field-label">Daily dollar cap</span>
            <input
              className="gs-field-input"
              type="number"
              min={0.5}
              step={0.5}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value))}
            />
            <span className="gs-field-hint">
              Hard ceiling on Anthropic spend per day. Combined with global cap{' '}
              {status.globalDailyDollarCap ? `($${status.globalDailyDollarCap.toFixed(2)})` : '(none)'} —
              whichever is lower wins. Resets at 00:00 UTC.
            </span>
          </label>
        </div>
      )}

      {error && <div className="gs-banner gs-banner-error">{error}</div>}
      {testResult && (
        <div className={`gs-banner ${testResult.ok ? 'gs-banner-ok' : 'gs-banner-error'}`}>
          {testResult.ok ? '✓ Connection works.' : `✗ ${testResult.error ?? 'Test failed.'}`}
        </div>
      )}

      <div className="gs-actions">
        <button className="gs-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {credentials?.mode !== 'Disabled' && (
          <button className="gs-btn gs-btn-ghost" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
      </div>
    </div>
  );
}
