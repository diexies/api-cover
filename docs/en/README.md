<div align="center">

<img src="../assets/logo.svg" alt="APICover logo" width="72" />

# APICover

**Cover every branch. Every variant. Before production does.**

Visual state-space testing tool for ASP.NET Core HTTP APIs.

[Türkçe](../tr/README.md) · [Русский](../ru/README.md) · [apicover.com](https://apicover.com)

</div>

---

## What is APICover?

APICover is an in-process **state-space exploration engine** for ASP.NET Core HTTP APIs. The observable behavior set of a REST API is a function not of its endpoint signatures, but of the triple *input combinations × execution order × shared state*. OpenAPI/Swagger documents only a projection of that space — the static contract surface; the branching topology of business flows (payment retry policies, idempotency violations, soft-delete cascades, race-prone slug generation) is not representable in any spec format. That representation gap is precisely why APICover exists.

Architecturally it operates in three layers:

**1. Live discovery.** APICover is not a proxy, sidecar, or external agent; it registers into the DI container via `AddAPICover()` and into the middleware pipeline via `UseAPICover()`. It reads the endpoint inventory from ASP.NET Core's own `IApiDescriptionGroupCollectionProvider` abstraction — i.e., it is fed from the exact same source of truth the framework's routing layer resolves. No hand-maintained spec file, no drift risk, no codegen step. On top of that it adds **IL-level static call-graph analysis**: it walks each endpoint's compiled body, resolves DI interface dispatches to concrete implementations, and classifies external HTTP calls and database boundaries (I/O boundaries). It makes the black box transparent from the outside in.

**2. Declarative scenario composition.** Scenarios are **DAGs** (directed acyclic graphs) composed on a canvas: nodes are HTTP invocations, edges are data and sequencing dependencies. The engine schedules the graph **concurrently via topological ordering** — independent branches run in parallel. Data flow between nodes is defined with **JSONLogic** expressions instead of imperative glue code: path, query, header, and body templates resolve against a live `RunContext` carrying upstream node responses (`nodes.<id>.response.*`). No fixtures, no serialization boilerplate — data binding is fully declarative.

**3. Combinatorial branching (branched execution).** The distinguishing mechanism is the **Case Set**: a variant collection attached to any node, carrying N variants with field-level overrides. When execution reaches that node, the engine applies **fork semantics** — it deep-clones the `RunContext` per variant and re-executes the downstream subtree in isolation for each branch. When Case Sets nest, branches multiply by **Cartesian product**: 3 variants on login × 2 on checkout = 6 fully-traced, independently-asserted execution branches from a single trigger. The combinatorial explosion is not unchecked: a **pre-flight branch estimator** computes the branch count before the run and rejects runs exceeding limits; at runtime, a semaphore-based concurrency bound and atomic counters (`MaxBranches=128`, `MaxConcurrentBranches=16`, `MaxLeafInvocations=4000`) form the second line of defense.

Every branch produces its own trace and pass/fail verdict keyed by `(nodeId, BranchPath)`; branch lifecycle is published in real time over SSE. The final artifact is a **tree-shaped coverage matrix** of the behaviors your API can exhibit under the defined input space — the engine-derived, first-class counterpart of what you used to imitate by cloning the same Postman collection twelve times and syncing it by hand.

## What does it aim for?

APICover's target user is the developer who has shipped a working ASP.NET Core API but didn't write — or doesn't fully command — all of the code underneath it, an increasingly common situation in AI-assisted codebases. You look at Swagger and see an endpoint list; but the system's behaviors (purchase flow, user provisioning, payment retry) are visible nowhere.

Each existing tool covers a single slice of API testing:

| | Live discovery | Visual flow | Branched state-space | Per-branch regression |
| --- | :---: | :---: | :---: | :---: |
| Postman / Insomnia | — | — | — | — |
| Cypress / Playwright | — | — | — | — |
| k6 / JMeter (load) | — | — | — | — |
| WireMock / MockServer | — | — | — | — |
| Hypothesis / property-based | — | — | partial | partial |
| **APICover** | **✓** | **✓** | **✓** | **✓** |

None of them combine all four: **live system discovery + visual flow editing + branched state-space exploration + per-branch regression detection.** That is exactly the gap APICover fills.

In short: a **Postman alternative** for teams who care about behaviors; a **Swagger alternative** for teams who want to see the system itself, not just its surface.

## Where can it be used?

- **Extracting behavior coverage** — seeing every path your API can take through a business flow (order, invoice, payment) in a single run, and tracking pass/fail per branch.
- **Understanding and validating AI-generated code** — seeing what a backend you didn't fully write actually does, from the outside in, via IL-level call-graph inspection (including concrete implementations behind DI interfaces, external HTTP and database boundaries).
- **Catching regressions** — saving scenarios and re-running them after every change; seeing which *branch* broke, at the behavior level rather than the endpoint level.
- **Escaping Postman collection duplication** — attaching a Case Set to a single scenario instead of cloning collections for "same flow, different input".
- **Multi-step integration tests** — without writing glue code or fixtures; path, query, header, and body fields are fed by inline JSONLogic expressions against upstream node responses.
- **Testing streaming endpoints** — SSE, NDJSON, and raw chunk streams, with conditional `until` rules that terminate the stream early.
- **Exploration and debugging** — setting a breakpoint to pause at a node, editing the request and resuming; repeating a subgraph N×M times with per-iteration mutations (Execution Groups).
- **Having AI write your tests** — letting the LLM in your IDE (Cursor, Copilot, Claude Code, Cline…) read the endpoint inventory over MCP, draft scenarios, run them, and report broken branches. Details below.

## How does it work?

Installation is two packages and three lines:

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

Boot your app, open `/apicover/ui/` — your endpoints are on the canvas.

Key architectural decisions:

- **No proxy, no SDK, no agent.** APICover is in-process middleware; it reads routes from ASP.NET Core's own `IApiDescriptionGroupCollectionProvider` — it sees exactly what the framework routes, and there is no separately-maintained spec file.
- **Guarded against state-space explosion.** A pre-flight branch estimator plus runtime caps (`MaxBranches`, `MaxConcurrentBranches`, `MaxLeafInvocations`) reject uncontrollably growing runs up front.
- **Pluggable storage.** In-memory by default; SQLite, SQL Server, and PostgreSQL providers plug in without touching application code. Scenarios and runs are stored as JSONB-style documents — no EF migrations to maintain.

## Test lifecycle

A behavior test's journey through APICover passes through five stages:

1. **Discovery.** As the app boots, APICover inventories every controller and minimal-API endpoint in the route table; with `EnableCallGraphInspection` on, it extracts the IL call graph per endpoint. No test you write can reference a nonexistent path — the inventory is the single source of truth.
2. **Authoring.** You build the DAG by wiring nodes on the canvas, or by writing the scenario JSON directly (by hand or via an LLM). Inter-node data dependencies are declared with JSONLogic; `scenarios.save` validates the id format and edge integrity at save time — a disconnected graph cannot be persisted.
3. **Execution.** The engine schedules the graph in topological order, runs independent branches in parallel, and forks at nodes carrying Case Sets. The run is live: node and branch events (`BranchSpawned`, `BranchCompleted`) stream over SSE; you can pause at a breakpoint, edit the request and resume, skip the branch, or abort the run.
4. **Verdict.** Every node of every branch produces its own result keyed by `(nodeId, BranchPath)`; pass/fail rolls up per leaf, and the tree view shows directly which variant combination broke. Failed nodes are stored in the run record with error detail (`statusCode`, `error`).
5. **Regression (history + re-run).** With persistent storage enabled, scenarios and run history survive restarts. You re-run the same scenario after every change and diff at branch level: the signal is not "the endpoint still returns 200" but "the partial-payment variant of the refund flow broke".

## AI agents and MCP integration

APICover talks to LLMs over two separate channels — you don't have to write tests by hand:

**Embedded Claude agent** (`APICover.Agent` package). Adds an Agent tab to the dashboard: chat, a system scan workflow, and project memory. Two credential modes — an Anthropic API key pasted into the UI, or a subscription session via the locally installed `claude` CLI. The agent drafts scenarios from *inside* the application, with access to the discovered endpoint inventory and call graph.

**MCP server** (`APICover.Mcp` package). Exposes **19 tools** over the Model Context Protocol, so the LLM in your IDE (Cursor, VS Code Copilot, Cline, Windsurf, Zed, Claude Desktop, Claude Code) can drive APICover's entire surface programmatically. Two transports are supported: **streamable HTTP** on the same host (`/apicover/mcp`) and **stdio** installed as a global dotnet tool (`APICover.Mcp.Stdio`).

The tool catalogue falls into six groups:

| Group | Tools | What it does |
|---|---|---|
| Scenarios | `scenarios.list` · `get` · `save` · `delete` · `run` | Scenario CRUD + triggering; `save` validates schema and edge integrity |
| Runs | `runs.list` · `list_failed` · `get` · `subscribe` | History queries; `list_failed` returns one row per failed node, `subscribe` streams progress live |
| Endpoints | `endpoints.list` · `details` | Inventory projection — area, purpose, parameters, sample bodies, auth |
| Memory | `memory.list` · `read` · `write` · `append` · `delete` | Path-sandboxed project knowledge under the agent memory root |
| Coverage | `coverage.summary` · `uncovered_endpoints` | What's tested, where the gaps are |
| Git | `git.commit_impact` | Diff → scenarios touched per file: "what does this commit break?" |

A typical MCP-driven session flows like this: the session playbook served at `{prefix}/api/mcp/playbook` is pasted to the LLM once; after that, saying *"write a scenario for `POST /invoices`"* makes the model read the real schema via `endpoints.details`, draft the scenario JSON, get your approval, run it via `scenarios.save` + `scenarios.run`, and report branch results live over `runs.subscribe`. *"Did commit `abc123` break anything?"* becomes the chain `git.commit_impact` → run impacted scenarios → summarize broken branches; *"what should we test next?"* becomes `coverage.uncovered_endpoints` → a prioritized proposal.

The playbook also enforces agent discipline: inventing paths not in the inventory is forbidden, showing the payload and getting approval before `scenarios.save` is mandatory, deletions require explicit confirmation in the same turn, and secrets from sample bodies must never be echoed back into chat.

## Tech stack

- **Backend**: .NET 8, ASP.NET Core, C# 12, EF Core 8 (storage), JSONLogic, JSON Path
- **Frontend**: React 18, TypeScript 5.6, Vite 5.4, XyFlow 12 (canvas), Dagre (layout)
- **Storage**: in-memory · SQLite · SQL Server · PostgreSQL
- **License**: MIT

## Status

> **0.1.0-alpha** · pre-release · breaking changes expected
>
> Engine + UI work end-to-end against the bundled sample app. 96 unit + 20 integration tests pass. The public API surface (`AddAPICover`, `UseAPICover`, `APICoverOptions`) may shift before 1.0.

To try it, the repo bundles a sample ASP.NET Core API (invoicing + payments + users) so you have a real, non-trivial target:

```bash
dotnet run --project samples/Utopia.Sample.WebApi
# → http://localhost:5050/apicover/ui/
```

For the long-form project narrative — why it exists, what's shipped, what's next — see [STORY.md](../../STORY.md).
