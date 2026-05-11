import { useEffect, useState } from 'react';
import { type McpInfo, getMcpInfo } from './api';

/**
 * MCP tab inside AgentPanel. Shows the workspace's MCP server status, the URL
 * to wire IDE LLMs against, and a tool catalogue. The "live connections" rail
 * lists clients that have called `initialize` recently — empty state guides
 * the user through wiring their first IDE if no connection has been observed.
 */
export function AgentMcpTab() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getMcpInfo()
      .then((r) => { if (alive) { setInfo(r); setLoading(false); } })
      .catch((e: Error) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  function copy(label: string, text: string) {
    try {
      navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
    } catch { /* clipboard blocked */ }
  }

  if (loading) {
    return <div className="agent-mcp"><div className="muted small">Loading…</div></div>;
  }
  if (error) {
    return <div className="agent-mcp"><div className="agent-memory-error">{error}</div></div>;
  }
  if (!info || !info.enabled) {
    return (
      <div className="agent-mcp">
        <div className="agent-memory-empty">
          <div className="agent-memory-empty-title">MCP not enabled</div>
          <p className="agent-memory-empty-body">
            Add the <code>APICover.Mcp</code> package to your host and call{' '}
            <code>builder.Services.AddAPICoverMcp();</code> after{' '}
            <code>AddAPICover()</code>. Restart the app to see this panel populate.
          </p>
        </div>
      </div>
    );
  }

  const stdioJson = JSON.stringify({
    mcpServers: { apicover: { command: info.stdioCommand, args: [] } },
  }, null, 2);
  const httpJson = JSON.stringify({
    mcpServers: { apicover: { url: info.httpUrl, type: 'streamableHttp' } },
  }, null, 2);

  return (
    <div className="agent-mcp">
      <div className="agent-mcp-head">
        <div className="agent-mcp-status is-on">●</div>
        <div className="agent-mcp-meta">
          <div className="agent-mcp-title">MCP server live</div>
          <code className="agent-mcp-url" title={info.httpUrl}>{info.httpUrl}</code>
        </div>
        <button
          type="button"
          className="agent-mcp-playbook-btn"
          onClick={() => copy('playbook', info.playbook)}
          title="Copy the session playbook — paste into your IDE LLM at the start of each chat so it knows when to call which tool."
        >
          {copied === 'playbook' ? '✓ Copied' : '✦ Copy session prompt'}
        </button>
        <button
          type="button"
          className="agent-memory-iconbtn"
          onClick={() => copy('url', info.httpUrl)}
          title="Copy MCP URL"
          aria-label="copy url"
        >{copied === 'url' ? '✓' : '⧉'}</button>
      </div>

      <div className="agent-mcp-body">
        <PlaybookCard
          markdown={info.playbook}
          copied={copied === 'playbook'}
          onCopy={() => copy('playbook', info.playbook)}
        />
        <ConnectCard
          title="Cursor / VS Code Copilot / Cline (HTTP)"
          json={httpJson}
          copied={copied === 'http'}
          onCopy={() => copy('http', httpJson)}
          hint="Add to mcp.json or the IDE's MCP settings panel. Streamable HTTP transport."
        />
        <ConnectCard
          title="Claude Desktop / Claude Code (stdio)"
          json={stdioJson}
          copied={copied === 'stdio'}
          onCopy={() => copy('stdio', stdioJson)}
          hint={
            <>Install the tool first: <code>dotnet tool install --global APICover.Mcp.Stdio</code>. Then drop this into <code>~/.claude/mcp.json</code> or Claude Desktop's settings.</>
          }
        />

        <section className="agent-mcp-section">
          <header className="agent-mcp-section-head">
            <span className="agent-mcp-section-title">tools</span>
            <span className="agent-mcp-section-count">{info.tools.length}</span>
          </header>
          <ul className="agent-mcp-tools">
            {info.tools.map((t) => (
              <li key={t.name} className="agent-mcp-tool">
                <code className="agent-mcp-tool-name">{t.name}</code>
                <span className="agent-mcp-tool-desc">{t.description}</span>
              </li>
            ))}
          </ul>
        </section>

        {info.requireAuth && (
          <div className="agent-mcp-note muted small">
            Auth required — IDE clients must include the configured Bearer token.
          </div>
        )}
      </div>
    </div>
  );
}

function PlaybookCard({
  markdown, copied, onCopy,
}: {
  markdown: string;
  copied: boolean;
  onCopy: () => void;
}) {
  // markdown is referenced for clipboard payload only — no in-UI preview by request.
  void markdown;
  return (
    <section className="agent-mcp-card is-playbook">
      <header className="agent-mcp-card-head">
        <span className="agent-mcp-card-title">session prompt</span>
        <button
          type="button"
          className="agent-mcp-card-cta"
          onClick={onCopy}
          title="Copy. Paste into your IDE's LLM session at the start of a chat."
        >{copied ? '✓ Copied' : '⧉ Copy'}</button>
      </header>
      <div className="agent-mcp-card-hint muted small">
        Drop this at the top of any new chat with your IDE's LLM (Cursor, Copilot,
        Claude, …) so it knows which APICover tool to reach for in each kind of
        question — failure triage, scenario authoring, coverage gaps, commit impact.
      </div>
    </section>
  );
}

function ConnectCard({
  title, json, hint, copied, onCopy,
}: {
  title: string;
  json: string;
  hint: React.ReactNode;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section className="agent-mcp-card">
      <header className="agent-mcp-card-head">
        <span className="agent-mcp-card-title">{title}</span>
        <button
          type="button"
          className="agent-memory-iconbtn"
          onClick={onCopy}
          title="Copy snippet"
          aria-label="copy snippet"
        >{copied ? '✓' : '⧉'}</button>
      </header>
      <pre className="agent-mcp-card-snippet">{json}</pre>
      <div className="agent-mcp-card-hint muted small">{hint}</div>
    </section>
  );
}
