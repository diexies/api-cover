import { useEffect, useMemo, useState } from 'react';
import {
  type McpInfo,
  type McpToolMeta,
  type LiveMcpConnection,
  type CustomToolDefinition,
  getMcpInfo,
  deleteCustomTool,
} from './api';
import { CreateCustomToolModal } from './CreateCustomToolModal';

/**
 * MCP tab inside AgentPanel. Two layouts:
 *  - Onboarding (no live MCP connection): shows IDE-config snippets, playbook copy, and the
 *    full tool catalogue so users can learn what is on offer before wiring an IDE.
 *  - Connected (≥1 client hit the MCP transport in the last 10 min): hides the IDE-config
 *    cards, surfaces a connection rail, and reduces noise to the catalogue + create flow.
 * Polls /info every 10s so the layout flips automatically when a client first connects.
 */
export function AgentMcpTab() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [restartBanner, setRestartBanner] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    function load() {
      getMcpInfo()
        .then((r) => { if (alive) { setInfo(r); setLoading(false); } })
        .catch((e: Error) => { if (alive) { setError(e.message); setLoading(false); } });
    }
    load();
    const interval = setInterval(load, 10000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  function copy(label: string, text: string) {
    try {
      navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
    } catch { /* clipboard blocked */ }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete custom tool "${name}"?`)) return;
    try {
      await deleteCustomTool(name);
      // Refresh
      const r = await getMcpInfo();
      setInfo(r);
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }

  function handleCreated(name: string) {
    setShowCreate(false);
    setRestartBanner(name);
    getMcpInfo().then(setInfo).catch(() => {});
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

  const connected = (info.liveConnections?.length ?? 0) > 0;

  return (
    <div className="agent-mcp">
      <div className="agent-mcp-head">
        <div className={`agent-mcp-status ${connected ? 'is-on' : 'is-idle'}`}>●</div>
        <div className="agent-mcp-meta">
          <div className="agent-mcp-title">
            {connected ? `MCP server live · ${info.liveConnections.length} client${info.liveConnections.length === 1 ? '' : 's'}` : 'MCP server idle'}
          </div>
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

      {connected && <ConnectionRail connections={info.liveConnections} />}

      {restartBanner && (
        <div className="agent-mcp-restart-banner">
          <div>
            <strong>Custom tool "{restartBanner}" saved.</strong>{' '}
            Restart the server for IDE clients to see it as a top-level tool. The in-app agent can already invoke it.
          </div>
          <button type="button" className="agent-memory-iconbtn" onClick={() => setRestartBanner(null)} aria-label="dismiss">✕</button>
        </div>
      )}

      <div className="agent-mcp-body">
        {!connected && (
          <>
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
          </>
        )}

        <ToolCatalogue
          tools={info.tools}
          onAdd={() => setShowCreate(true)}
          onDelete={handleDelete}
        />

        {info.requireAuth && (
          <div className="agent-mcp-note muted small">
            Auth required — IDE clients must include the configured Bearer token.
          </div>
        )}
      </div>

      {showCreate && (
        <CreateCustomToolModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

function ConnectionRail({ connections }: { connections: LiveMcpConnection[] }) {
  return (
    <div className="agent-mcp-connection-rail">
      <span className="agent-mcp-connection-rail-label">connections</span>
      {connections.map((c) => (
        <span
          key={c.clientId}
          className="agent-mcp-connection-chip"
          title={`${c.userAgent ?? 'unknown UA'} · ${c.ip} · ${c.requestCount} request${c.requestCount === 1 ? '' : 's'} · last seen ${formatRel(c.lastSeen)}`}
        >
          <span className="agent-mcp-connection-dot">●</span>
          <span className="agent-mcp-connection-id">{shortId(c.clientId)}</span>
          <span className="agent-mcp-connection-ts muted">{formatRel(c.lastSeen)}</span>
        </span>
      ))}
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function formatRel(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ago`;
}

function ToolCatalogue({
  tools, onAdd, onDelete,
}: {
  tools: McpToolMeta[];
  onAdd: () => void;
  onDelete: (name: string) => void;
}) {
  const grouped = useMemo(() => groupByCategory(tools), [tools]);
  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set(grouped.map((g) => g.category)));

  function toggle(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  return (
    <section className="agent-mcp-section">
      <header className="agent-mcp-section-head">
        <span className="agent-mcp-section-title">tools</span>
        <span className="agent-mcp-section-count">{tools.length}</span>
        <button
          type="button"
          className="agent-mcp-add-tool-btn"
          onClick={onAdd}
          title="Define a custom HTTP-proxy tool that this MCP server will expose"
        >＋ Add tool</button>
      </header>
      <div className="agent-mcp-catalogue">
        {grouped.map((g) => {
          const open = openCats.has(g.category);
          return (
            <div key={g.category} className="agent-mcp-cat">
              <button
                type="button"
                className={`agent-mcp-cat-head${open ? ' is-open' : ''}`}
                onClick={() => toggle(g.category)}
              >
                <span className="agent-mcp-cat-caret">{open ? '▾' : '▸'}</span>
                <span className="agent-mcp-cat-name">{g.category}</span>
                <span className="agent-mcp-cat-count">{g.tools.length}</span>
              </button>
              {open && (
                <ul className="agent-mcp-tools">
                  {g.tools.map((t) => (
                    <li key={t.name} className={`agent-mcp-tool-card${t.isCustom ? ' is-custom' : ''}`}>
                      <div className="agent-mcp-tool-head">
                        <code className="agent-mcp-tool-name">{t.name}</code>
                        {t.isCustom && <span className="agent-mcp-tool-badge">custom</span>}
                        {t.isCustom && (
                          <button
                            type="button"
                            className="agent-mcp-tool-delete"
                            onClick={() => onDelete(t.name)}
                            title="Delete custom tool"
                            aria-label={`delete ${t.name}`}
                          >🗑</button>
                        )}
                      </div>
                      {t.whenTriggered && (
                        <div className="agent-mcp-when-chip">
                          <span className="agent-mcp-when-label">when</span>
                          <span className="agent-mcp-when-text">{t.whenTriggered}</span>
                        </div>
                      )}
                      <div className="agent-mcp-tool-desc">{t.description}</div>
                      {t.paramsSchema !== undefined && t.paramsSchema !== null && (
                        <details className="agent-mcp-params">
                          <summary>params schema</summary>
                          <pre className="agent-mcp-params-snippet">{JSON.stringify(t.paramsSchema, null, 2)}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function groupByCategory(tools: McpToolMeta[]): { category: string; tools: McpToolMeta[] }[] {
  const map = new Map<string, McpToolMeta[]>();
  for (const t of tools) {
    const cat = t.category || 'general';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(t);
  }
  return [...map.entries()]
    .sort(([a], [b]) => {
      // "custom" floats to bottom; otherwise alphabetical
      if (a === 'custom') return 1;
      if (b === 'custom') return -1;
      return a.localeCompare(b);
    })
    .map(([category, ts]) => ({ category, tools: ts.sort((x, y) => x.name.localeCompare(y.name)) }));
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

export type { CustomToolDefinition };
