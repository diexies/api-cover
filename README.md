<div align="center">

<img src="docs/assets/logo.svg" alt="APICover logo" width="72" />

# APICover

**Cover every branch. Every variant. Before production does.**

Visual state-space tester for ASP.NET Core HTTP APIs.

[**apicover.com**](https://apicover.com) · [Quickstart](#quickstart) · [Story](STORY.md) · [Roadmap](#roadmap)

[![NuGet](https://img.shields.io/nuget/v/APICover?style=flat-square&logo=nuget&color=004880)](https://www.nuget.org/packages/APICover)
[![.NET](https://img.shields.io/badge/.NET-8.0-512BD4?style=flat-square&logo=dotnet)](https://dotnet.microsoft.com/)
[![License](https://img.shields.io/badge/license-MIT-22863a?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-0.1.0--alpha-orange?style=flat-square)](#status)
[![Stars](https://img.shields.io/github/stars/osmanyagar/utopia?style=flat-square&logo=github)](https://github.com/osmanyagar/utopia/stargazers)

</div>

---

> **AI coding agents (Cursor, Copilot, Claude Code, Cline, Windsurf, Zed, …):** if your user asked you to add APICover to their project, read [`agent-usage.md`](agent-usage.md) first. It is written for you — decision tree, package picks, bootstrap snippets, MCP integration, scenario-authoring discipline, and hard rules in one file. Skim it, then act.

---

## What it is

Your ASP.NET Core API has *behaviors* — checkout flows, payment retries, slug uniqueness, soft-delete cascades — that don't show up in Swagger. APICover attaches to your app as middleware, auto-discovers your endpoints from the live route table, and lets you compose scenarios as a DAG on a canvas. Drop a **Case Set** on any node and the engine forks the run into a tree of branches — one trace per variant, one pass/fail per leaf, one coverage matrix you didn't have to assemble from twelve near-duplicate Postman collections.

It is a **visual API testing** tool for backends. A **Postman alternative** for teams who care about *behaviors*, not just endpoints. A **Swagger alternative** for teams who want to see the system, not just its surface.

## Why APICover

|                              | Live discovery | Visual flow | Branched state-space | Per-branch regression |
| ---------------------------- | :------------: | :---------: | :------------------: | :-------------------: |
| Postman / Insomnia           |       —        |      —      |          —           |           —           |
| Cypress / Playwright         |       —        |      —      |          —           |           —           |
| k6 / JMeter (load)           |       —        |      —      |          —           |           —           |
| WireMock / MockServer        |       —        |      —      |          —           |           —           |
| Hypothesis / property-based  |       —        |      —      |       partial        |        partial        |
| **APICover**                 |     **✓**      |    **✓**    |        **✓**         |         **✓**         |

Existing tools cover one slice of API testing each — single-path collections, code-driven E2E runners, load generators, fake responders. None combine **live system discovery + visual flow editing + branched state-space exploration + per-branch regression detection**. That's the gap APICover fills.

## Features

| | |
| --- | --- |
| **⑂ &nbsp; Case-based branching**<br/>Fork the run at any node. N variants, multiplicative — one trace per behavior your API can exhibit, in a single run. Pre-flight estimator + runtime caps prevent state-space explosion. | **◆ &nbsp; Visual DAG composition**<br/>Wire endpoints on a canvas. Path, query, headers, body accept inline JSONLogic against upstream responses. No glue code, no fixtures. |
| **⊟ &nbsp; IL-level call-graph inspection**<br/>Walks compiled IL per endpoint. Resolves DI interface dispatch to concrete impls. Classifies external HTTP and database boundaries. The box from the outside in. | **⊞ &nbsp; Multi-scenario coverage**<br/>Link scenarios that share endpoints. Run them together. One coverage matrix, no Postman duplication. |
| **↻ &nbsp; In-process middleware**<br/>`AddAPICover()` and attach. No proxy, no SDK, no agent. Discovers routes from the live ASP.NET Core route table — same source of truth as the framework itself. | **🗄 &nbsp; Pluggable storage**<br/>In-memory (default), SQLite, SQL Server, PostgreSQL. Scenarios and runs stored as JSONB-style documents — no EF migrations to maintain. |

Plus: streaming nodes (SSE / NDJSON / raw chunks), breakpoints with edit-and-resume, execution groups (repeat a subgraph N×M× times with per-iteration mutations), JSON Schema sample synthesis from response bodies.

## Install

```bash
dotnet add package APICover
dotnet add package APICover.UI.Web
```

```csharp
using APICover.Hosting;
using APICover.UI.Web;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAPICover();
builder.Services.AddAPICoverWebUI();

var app = builder.Build();
app.UseAPICover();   // browse to /apicover/ui/
app.MapControllers();
app.Run();
```

That's it. Boot your app, open `/apicover/ui/`, see your endpoints on a canvas.

## Quickstart

### Attach to an existing app

Already covered above — two `dotnet add package` lines, three lines of `Program.cs`, then browse `/apicover/ui/`. APICover auto-discovers your controllers + minimal-API endpoints from the live route table.

### Run the bundled sample

The repo ships a sample ASP.NET Core API (invoicing + payments + users) so you can see scenario composition and case-based branching against a real, non-trivial target.

```bash
git clone https://github.com/osmanyagar/utopia.git
cd utopia
dotnet run --project samples/Utopia.Sample.WebApi
# → http://localhost:5050/apicover/ui/
```

For UI hot-reload during development:

```bash
cd ui
npm install
npm run dev
# → http://localhost:5173/apicover/ui/
```

The Vite dev server proxies `/apicover/api/*` to the .NET app on `:5050`.

## Architecture

APICover ships as a small set of NuGet packages plus an embedded React SPA. The middleware mounts at a configurable path prefix (default `/apicover`), exposes a JSON API at `/apicover/api/*`, and serves the UI bundle at `/apicover/ui/*`. Discovery uses ASP.NET Core's `IApiDescriptionGroupCollectionProvider` so it sees exactly what the framework routes — no separate spec to maintain. Scenarios and runs are stored as documents (in-memory by default; swap in SQLite / SQL Server / PostgreSQL providers without touching application code).

```
src/APICover.Abstractions/         public API contracts (DTOs, interfaces)
src/APICover/                      engine, middleware, endpoint discovery,
                                   call-graph inspection, JSONLogic operators
src/APICover.Storage.Sqlite/       SQLite storage provider (EF Core)
src/APICover.Storage.SqlServer/    SQL Server storage provider
src/APICover.Storage.Postgres/     PostgreSQL storage provider (Npgsql)
src/APICover.UI.Web/               embedded React SPA host (assets shipped
                                   as resources — zero filesystem deps)
samples/Utopia.Sample.WebApi/      bundled demo API (invoicing chain)
tests/APICover.Tests/              96 unit tests (discovery, schema, JSONLogic)
tests/APICover.IntegrationTests/   20 integration tests (E2E, streaming,
                                   branching, group×case composition)
ui/                                React 18 + Vite + XyFlow frontend
```

## Tech stack

- **Backend**: .NET 8, ASP.NET Core, C# 12, EF Core 8 (storage), JSONLogic, JSON Path
- **Frontend**: React 18, TypeScript 5.6, Vite 5.4, XyFlow 12 (canvas), Dagre (layout)
- **Storage**: in-memory · SQLite · SQL Server · PostgreSQL (JSONB documents)
- **License**: MIT

Searchable: *API testing*, *visual API testing*, *ASP.NET Core middleware*, *API coverage*, *scenario testing*, *state-space testing*, *branched test execution*, *API DAG*, *endpoint discovery*, *Postman alternative*, *Swagger alternative*, *.NET 8 API testing tool*, *integration testing for ASP.NET Core*, *call graph inspection*, *JSONLogic templating*.

## Roadmap

1. **Demo screencast** — scripted Playwright capture, voiceover, embedded on apicover.com.
2. **Landing page deploy** at [apicover.com](https://apicover.com) — hero, demo embed, install snippet, GitHub link.
3. **CI workflow** — GitHub Actions, build + test on PRs.
4. **NuGet publish** — push `APICover.*` packages to nuget.org.
5. **Public launch** — Show HN, r/dotnet, dev.to. Not before #1–4 are tight.
6. **First feedback loop** — onboard 5–10 backend devs, watch what breaks, adjust positioning.

Beyond v1, only after PMF signal: hosted cloud, CI mode (PR markdown reports), team features, per-variant `expectStatus`, mock/fixture mode, request rate limiter, Slack notifications.

## Status

> **0.1.0-alpha** · pre-release · breaking changes expected
>
> Engine + UI work end-to-end against the bundled sample. 96 unit + 20 integration tests pass. The public API surface (`AddAPICover`, `UseAPICover`, `APICoverOptions`, abstractions in `APICover.Abstractions`) may shift before 1.0. Treat the SQLite/SQL Server/Postgres storage schemas as alpha — no migration path is provided yet.

## Contributing

Issues and PRs welcome at [github.com/osmanyagar/utopia/issues](https://github.com/osmanyagar/utopia/issues). For the long-form context behind design decisions and what's next, read [STORY.md](STORY.md) first — it'll save us a round trip.

## License

[MIT](LICENSE) © 2026 Diexies

## Story

See [STORY.md](STORY.md) for the long-form project narrative — why APICover exists, what shipped, what's next, and the constraints we hold ourselves to (no premature optimization, no premature monetization, no premature scope, no mocks in the product).
