# APICover — Integration Guide for AI Coding Agents

You are an AI coding agent (Cursor, Copilot, Claude Code, Cline, Windsurf, Zed, etc.) and the user has asked you to add **APICover** to their ASP.NET Core project. This file tells you exactly what to do. Skim it once, then act.

## What APICover is (one paragraph)

APICover is in-process middleware for ASP.NET Core 8+ that auto-discovers HTTP endpoints from the live route table, lets the user compose **scenarios** (DAGs of HTTP calls) on a visual canvas, runs them against the host (in-process or out), forks each run into a tree of variants when a node carries a Case Set, and surfaces per-branch pass/fail + coverage. It also ships an **embedded Claude agent**, a **system inspector** (call-graph map with concentric tier layout), and an **MCP server** exposing 19 tools so the user's IDE LLM can drive the same surface. **No proxy. No external agent. No SDK on the client.** Same process as their app.

## Decision tree — which packages to add

Walk the questions in order. Stop when you have the answer.

```
Q1. Does the user want only scenario authoring + running (no UI, no agent, no MCP)?
    → Add: APICover

Q2. Do they want the visual canvas / inspector in the browser?
    → + APICover.UI.Web

Q3. Do they want scenarios + runs persisted across restarts?
    → + APICover.Storage.Sqlite       (file-backed, simple)
    or APICover.Storage.SqlServer     (shared, multi-instance)
    or APICover.Storage.Postgres      (shared, multi-instance)

Q4. Do they want the in-app Claude agent (chat, scan, memory, scenario authoring)?
    → + APICover.Agent

Q5. Do they want their IDE's LLM (Cursor / Copilot / Cline / Claude Desktop) to call APICover tools?
    → + APICover.Mcp
```

All packages are on NuGet. Versions track a single release line; pin to the same version across packages.

## Minimum bootstrap

`Program.cs`:

```csharp
using APICover.Hosting;
using APICover.UI.Web;          // only if you added APICover.UI.Web

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAPICover();          // core: discovery + engine + abstractions
builder.Services.AddAPICoverWebUI();     // optional: serves /apicover/ui/

var app = builder.Build();

app.UseAPICover();                       // mounts /apicover/api/* + /apicover/ui/
app.MapControllers();
app.Run();
```

After build, the user opens `http://localhost:<port>/apicover/ui/`. The canvas lists every controller + minimal-API endpoint with zero extra config.

**Do not** call `AddAPICover()` more than once. **Do not** put it behind a feature flag the user has to toggle to discover endpoints — discovery runs at startup.

## Add storage (persisted scenarios + runs)

Choose one. `AddAPICover` already wires in-memory defaults; storage extensions override them.

```csharp
// SQLite (file under the content root)
builder.Services.AddAPICover()
                .AddSqliteStorage(opts => opts.ConnectionString = "Data Source=apicover.db");

// SQL Server
builder.Services.AddAPICover()
                .AddSqlServerStorage(opts => opts.ConnectionString = config.GetConnectionString("APICover"));

// Postgres
builder.Services.AddAPICover()
                .AddPostgresStorage(opts => opts.ConnectionString = config.GetConnectionString("APICover"));
```

Schemas are JSONB-style documents — no EF migrations. Treat them as alpha; do not lean on the table layout in user code.

## Add the embedded Claude agent

`APICover.Agent` registers chat, memory store, scan workflow, and credential handling. Two modes:
- **API key**: user pastes an Anthropic key into the UI's Agent Settings.
- **Max (subscription)**: agent shells out to the local `claude` CLI; the user must have it installed and authenticated (`claude login`).

```csharp
using APICover.Agent.Hosting;

builder.Services.AddAPICover()
                .AddAPICoverAgent();     // chat, memory, scan, credentials
```

The Agent tab appears in the home dashboard. Memory files live under `docs/apicover-agent/memory/` in the content root. Do not commit them — gitignore that directory.

## Add the MCP server (drive APICover from the user's IDE LLM)

Two transports. Pick by how the user will connect.

### HTTP transport (Cursor, VS Code Copilot, Cline, Windsurf, Zed, Claude Desktop streamable)

```csharp
using APICover.Mcp.Hosting;

builder.Services.AddAPICover()
                .AddAPICoverAgent()
                .AddAPICoverMcp();       // mounts at /apicover/mcp
```

The MCP endpoint is at `{prefix}/mcp` on the same host the inspector serves. Metadata for the in-app MCP tab lives at `{prefix}/api/mcp/info`.

User pastes this into their IDE's `mcp.json`:

```jsonc
{
  "mcpServers": {
    "apicover": {
      "url": "http://localhost:5050/apicover/mcp",
      "type": "streamableHttp"
    }
  }
}
```

### Stdio transport (Claude Desktop, Claude Code, generic stdio MCP clients)

User installs the global dotnet tool once:

```bash
dotnet tool install --global APICover.Mcp.Stdio
```

Then in their MCP client config:

```jsonc
{
  "mcpServers": {
    "apicover": { "command": "apicover-mcp", "args": [] }
  }
}
```

The stdio process runs in the user's workspace directory and reads the same `appsettings.json` / env vars the host app does, so storage + discovery configuration carry over.

### Auth on HTTP MCP

Off by default (the inspector is assumed to be behind the host's existing firewall / reverse proxy). Turn on when MCP is exposed publicly:

```csharp
builder.Services.AddAPICoverMcp(o => o.RequireAuth = true);
```

`RequireAuthorization()` is then applied to the MCP endpoints. The user must configure an auth scheme (typically `AddJwtBearer`) **before** calling `AddAPICoverMcp`.

## MCP tool catalogue (what IDE LLMs can call)

19 tools, snake-case names. The full session playbook is served at `{prefix}/api/mcp/playbook` and copy-buttoned from the in-app MCP tab — paste it into the user's IDE chat once per session so the model knows when to reach for which tool.

| Group | Tools | Notes |
|---|---|---|
| Scenarios | `scenarios.list`, `scenarios.get`, `scenarios.save`, `scenarios.delete`, `scenarios.run` | `save` validates `id` regex `^[a-z0-9-]+$` and edge integrity. |
| Runs | `runs.list`, `runs.list_failed`, `runs.get`, `runs.subscribe` | `list_failed` returns one row per failed node with `{runId, scenarioId, nodeId, method, path, statusCode, error}`. `subscribe` streams progress notifications. |
| Endpoints | `endpoints.list`, `endpoints.details` | Mirrors the inspector's projection — area, purpose, parameters, samples, auth. |
| Memory | `memory.list`, `memory.read`, `memory.write`, `memory.append`, `memory.delete` | Path-sandboxed under the agent memory root. |
| Coverage | `coverage.summary`, `coverage.uncovered_endpoints` | What's tested, what's a gap. |
| Git | `git.commit_impact` | Diff + per-file `scenariosTouched` so the LLM can answer "what did this commit affect?" |

## When the user asks you to author a scenario

1. Call `endpoints.list` (or `endpoints.details(id)` for one) — never invent paths.
2. Draft the scenario as JSON. Schema (shortened):
   ```json
   {
     "id": "kebab-case",
     "name": "human label",
     "nodes": [
       {
         "id": "n1",
         "method": "POST",
         "path": "/users",
         "body": { "name": "Ada" }
       }
     ],
     "edges": [ { "from": "n1", "to": "n2", "mode": "Sequential" } ]
   }
   ```
   `mode` is `Sequential` or `Parallel`. `body` may be JSON or a JSONLogic expression for derived values.
3. Show the user the JSON. **Wait for approval before saving.**
4. Call `scenarios.save(scenario)`.
5. Verify by calling `scenarios.run(id)` and `runs.subscribe(runId)`.

## Common pitfalls

- **`AddAPICoverMcp` before `AddAPICover`**: registration order matters. MCP tools resolve `IScenarioStore`, `IEndpointDiscoveryService`, `IAgentMemoryStore` from DI. Call `AddAPICover()` (and `AddAPICoverAgent()` if memory tools are needed) **first**.
- **Endpoint discovery missing some routes**: APICover discovers from `IApiDescriptionGroupCollectionProvider`. Minimal-API endpoints without `WithName` / metadata still surface, but route handlers attached after `app.Build()` may not. Wire all `MapXxx` calls before any `app.Run()`-equivalent.
- **Call-graph inspection requires `EnableCallGraphInspection = true`** in `APICoverOptions`. Off by default in release. Turn on for local + staging only.
- **Agent CLI mode + Max subscription**: the embedded agent shells out to `claude`. If the CLI is missing or unauthenticated, every chat fails with `claude exited 1`. Test with `claude --version` before integrating.
- **Memory store path collisions**: by default, agent memory lives under `<ContentRoot>/docs/apicover-agent/memory/`. Don't write user data there — the agent treats files in that root as project knowledge.

## How to debug discovery

Open `/apicover/api/endpoints` and inspect the JSON. Every route the framework sees should be there. If a route is missing:
1. Check `[ExploreIgnore]` isn't on the action or controller.
2. Confirm the route is registered before `app.Run()`.
3. For controllers, confirm `app.MapControllers()` runs after `services.AddControllers()`.

`/apicover/api/service-map` shows the call-graph derived map (services, interfaces, DB / external boundaries, app root). Empty? `EnableCallGraphInspection` is off.

## What an MCP-driven workflow looks like

A user opens their IDE, the LLM has the APICover MCP server configured, they paste the session playbook into the chat, and then:

- "What scenarios do we have?" → LLM calls `scenarios.list`.
- "What's broken right now?" → `runs.list_failed`, then `runs.get(runId)` for root cause.
- "Write a scenario for `POST /invoices`." → `endpoints.details(id)`, draft JSON, confirm, `scenarios.save`, `scenarios.run`.
- "Did commit `abc123` break anything?" → `git.commit_impact`, identify impacted scenarios, `scenarios.run` per id, summarise failures.
- "What should we test next?" → `coverage.uncovered_endpoints`, rank, propose three concrete scenarios.

The session playbook (`McpPlaybook.Markdown` in source) is opinionated about all of the above — pasting it once turns a generic LLM into an APICover assistant for that session.

## Hard rules for AI agents

- **Never invent endpoint paths.** If `endpoints.list` does not show one, it does not exist for this workspace.
- **Never call `scenarios.save` or `memory.write` without showing the payload first and getting user approval.**
- **Never call `scenarios.delete` or `memory.delete` without explicit user confirmation in the same turn.**
- **Never echo secrets** (tokens, keys, auth headers) from `endpoints.details.samples` back into chat output.
- **Prefer `runs.subscribe` over polling `runs.get`** for live runs — the SDK forwards progress notifications so you can narrate milestones as they happen.

## Where to look next

- `README.md` — user-facing quickstart, feature matrix.
- `STORY.md` — design rationale, what's coming.
- `samples/Utopia.Sample.WebApi/` — fully wired sample. Read `Program.cs` to see every extension method in context.
- `src/APICover.Mcp/Hosting/McpPlaybook.cs` — the session playbook source. Copy when generating IDE chat priming.
- `/apicover/api/mcp/info` — live tool catalogue + transport URLs from the running host.
