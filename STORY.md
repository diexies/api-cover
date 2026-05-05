# APICover — Project Story

> Where we are, where we're going, and how we got here. Updated alongside
> major changes — the single source of truth for "what is this project
> right now?" beyond what code can tell you.

## What it is

APICover is a **visual state-space tester for HTTP APIs**. You attach
APICover to your ASP.NET Core app as middleware, it auto-discovers your
endpoints, and you compose scenarios as a DAG on a canvas — nodes are API
calls, edges are sequencing.

The differentiator: at any node you can drop a **Case Set** with N variants.
At run time the engine forks the execution at that node, deep-clones the
run context per variant, and runs the downstream subtree once per variant.
Variants nest multiplicatively — 3 cases on the login node and 2 cases on
the checkout node yield 6 fully-traced branches in a single run.

Each branch reports its own pass/fail. The result is a tree view of every
behavior your API can exhibit under the inputs you defined — coverage
matrix as a first-class artifact, not something you assemble by hand from
twelve near-duplicate Postman collections.

## Why it exists

The target user is the **vibe-coded backend developer** — someone who
shipped a working ASP.NET Core API but didn't fully write or fully
understand the AI-generated code under it. They look at Swagger and see
endpoints, but the *behaviors* of the system (purchase flow, user
provisioning, payment retry, slug uniqueness) are not visible anywhere.

Existing tools each cover one slice:

- **Postman / Insomnia** — single-path collections, one combination per run.
- **Cypress / Playwright** — code-driven, no visual coverage matrix.
- **k6 / JMeter** — load tests, not behaviour coverage.
- **WireMock / MockServer** — fake responses, not real-system testing.
- **Hypothesis / property-based testing** — text-based, no API graph.

Nobody combines: live system discovery + visual flow editing + branched
state-space exploration + per-branch regression detection. That's the gap.

## What's shipped right now

### Engine
- DAG executor with concurrent topological scheduling (`ScenarioEngine.cs`).
- JSONLogic everywhere: path, query, header, body templates resolve
  against a live `RunContext` carrying `nodes.<id>.response.*` from
  upstream nodes.
- Streaming nodes: SSE, NDJSON, raw chunks with conditional `until`
  predicate to terminate streams early.
- Breakpoints: pause at any node, edit the request, resume / skip / abort.
- Execution Groups: repeat a subgraph N×M× times with per-iteration
  JSONLogic mutations.
- **Case Sets (the killer feature)**: anchor + N variants + per-variant
  field overrides. Engine forks at the anchor, deep-clones the
  `RunContext` per variant, runs the downstream subtree independently per
  branch.
- **Pre-flight branch estimator** (`BranchEstimator.cs`) and runtime
  caps: `MaxBranches=128`, `MaxConcurrentBranches=16`,
  `MaxLeafInvocations=4000`. Pre-flight rejects runs that would explode;
  runtime semaphore + interlocked counter back it up.
- Flat `Run.NodeResults` list keyed by `(nodeId, BranchPath)` — one
  record per node per branch. SSE bus emits `BranchSpawned` and
  `BranchCompleted` alongside the existing node events.

### Storage
- In-memory (default), SQLite, SQL Server, PostgreSQL providers — all
  store `Scenario` and `Run` as JSONB-style documents, so model
  evolution doesn't need EF migrations.

### UI
- React 18 + Vite + XyFlow canvas + dagre layout.
- **FlowHeader**: editable name + tag chips + collapsible description
  above the canvas. Reframes scenarios as named "business flows".
- **Sidebar**: "Business Flows" → "Multi-step Flows" / "Single Calls"
  sections. Each item shows description preview + tag chips.
- **Canvas**:
  - Node positions persist across reloads.
  - Anchor pill (`⑂N`) renders on case-set anchor nodes.
  - Right-click an api-node → menu includes "Add cases / Edit cases /
    Remove cases" alongside group actions.
- **Inspector**:
  - 5 tabs: overview / request / wiring / branching / history.
  - Request tab — path, query, headers, body. Values accept inline
    JSONLogic directly (no separate "bindings" layer; that construct
    was removed because it was redundant with template-time evaluation).
  - Branching tab — both ExecutionGroups (repeats) and CaseSets (forks)
    edited in one place. Per-variant card has a `field → value` row
    editor.
- **BranchTree** component above the canvas: leaf-by-leaf summary of a
  branched run, with status pill, branch path, label chain.

### Tests
- 96 unit tests (discovery, schema, JSONLogic helpers).
- 20 integration tests (E2E scenarios, streaming, conditional input,
  execution groups, case branching — single fork, cartesian nesting,
  cap rejection, group×case composition).

## Stage

**0.1.0-alpha — public, pre-1.0.**

The product works end-to-end against the bundled sample API. Engine has
been refactored for branched execution and survives existing regression
tests. UI surfaces the new feature via canvas badge + inspector editor +
branch diagram.

What's still pending:
- Public README with screenshots and demo video. *(README done; screenshots/video pending.)*
- Landing page deploy at apicover.com.
- CI workflow (GitHub Actions).
- NuGet package publish.
- First external user.

## Recent work (the road behind us)

The last sprint, in chronological order:

1. **Bindings construct removed.** The original UI had a separate
   "bindings" panel that overrode request fields after the request was
   built. The engine already evaluated JSONLogic in path/query/header/
   body templates at request-build time, so bindings were a redundant
   second pass. We deleted them: `BindingsEditor.tsx`,
   `ResponseTreePicker.tsx`, `ApiNode.InputBindings`,
   `ApplyInputBindings`. Path/query/header values now accept inline
   JSONLogic directly; the request tab hints the syntax.

2. **Business-flow framing.** Scenarios renamed from "Last scenarios" to
   "Business Flows" in the sidebar; sections rebranded "Multi-step
   Flows" / "Single Calls". Added `Scenario.Tags` and a
   `FlowHeader` component that puts editable name + description + tag
   chips at the top of the canvas. Canvas node positions now persist
   into `ApiNode.Position` on save and restore on load.

3. **Case-based branching (the killer feature).** New
   `CaseSet`/`CaseVariant`/`NodeFieldOverride`/`BranchPath` model;
   `BranchExecState` per-branch execution state inside `ScenarioEngine`;
   pre-flight estimator + runtime caps; `Run.NodeResults` flattened to
   `IList<NodeResult>` with `BranchPath` per entry; new SSE event types;
   UI integration end to end (canvas pill, Cases editor in
   `BranchingTab`, `BranchTree` summary, right-click menu).

4. **Story planning + brand work.** Reframed the product positioning
   from "API testing platform" (crowded, undifferentiated) to "visual
   state-space tester for vibe-coded backends" (sharp niche, real
   problem, no direct competitor). Bought `apicover.com`. Drafted hero
   taglines along the "cover every branch / every variant" axis.

5. **Public-release cleanup.** MIT LICENSE added, public README written,
   NuGet metadata wired, brand rename `Utopia.Inspector.*` → `APICover.*`
   completed across csprojs, namespaces, sln, UI references, HTTP path
   prefix (`/inspector` → `/apicover`), Postgres tables, and test env
   vars. `feat/case-branching` merged to `main`; v0.1.0-alpha tagged.

## Where we go next

Roughly in priority order:

1. **Demo screencast** — script + Playwright capture + voiceover.
2. **Landing page deploy** at apicover.com — hero pitch, demo video
   embed, GitHub link, install snippet.
3. **CI workflow** — GitHub Actions: build + test on PRs.
4. **NuGet publish** — push `APICover.*` packages to nuget.org.
5. **Launch posts** — Hacker News (Show HN), r/dotnet, r/programming,
   Twitter/X, dev.to. Not before #1–4 are tight.
6. **First feedback loop** — DM 5–10 vibe-coded backend devs, get them
   to run it, watch what breaks. Adjust positioning based on what they
   actually understand without help.

Only after a real PMF signal: pricing, hosted cloud, CI mode (GitHub
Action that posts a markdown report to PR), team features.

## Self-imposed constraints

- **No premature optimization.** Deep-cloning `RunContext` per fork is
  expensive in theory; we ship the dumb version first and only refactor
  to copy-on-write if profiling shows pain.
- **No mocks in the product.** "APICover" is not a mock server; it
  tests the *real* host application. The brand stays consistent with
  that — we never let "mock" into the marketing copy.
- **No premature monetization.** Open-source core, free local use, paid
  cloud / CI / team features later when there's signal.
- **No premature scope.** Per-variant `expectStatus`, mock/fixture
  mode, request rate limiter, Slack notifications, GitHub PR comments
  are real future features but explicitly out of scope until v1 lands
  with feedback.

## How to read the codebase

- `/src/APICover.Abstractions/` — public API contracts.
- `/src/APICover/Engine/ScenarioEngine.cs` — the heart. Read
  `StartAsync` → `ExecuteAsync` → `RunNode` → `RunVariantBranch`.
- `/src/APICover/Engine/BranchEstimator.cs` — pre-flight cap
  arithmetic.
- `/ui/src/ScenarioCanvas.tsx` — react-flow canvas + run state machine.
- `/ui/src/inspector/BranchingTab.tsx` — repeats + cases editor.
- `/ui/src/inspector/BranchTree.tsx` — per-branch run summary.
- `/tests/APICover.IntegrationTests/CaseBranchingTests.cs` — six
  tests that document the engine's branching contract.

If you read those eight files in order, you have the whole story.
