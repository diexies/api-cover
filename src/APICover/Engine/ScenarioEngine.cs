using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Models;
using APICover.Abstractions.Services;

namespace APICover.Engine;

/// <summary>
/// Default <see cref="IScenarioEngine"/> implementation. Executes a scenario DAG with a
/// concurrent topological strategy: any node whose predecessors have all completed
/// successfully starts immediately, fanning out parallel branches via <see cref="Task"/>s.
/// On a node failure the run is marked <see cref="RunStatus.Failed"/> and downstream nodes
/// are marked <see cref="NodeStatus.Skipped"/>; sibling branches continue to completion.
/// </summary>
public sealed class ScenarioEngine : IScenarioEngine
{
    private readonly IRuleEvaluator _evaluator;
    private readonly IBreakpointController _breakpoints;
    private readonly IRunStore _runStore;
    private readonly IRunEventBus _eventBus;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<APICoverOptions> _options;
    private readonly ILogger<ScenarioEngine> _logger;

    internal const string HttpClientName = "APICover";

    /// <summary>Public alias of the named <see cref="HttpClient"/> used by the engine.</summary>
    public const string HttpClientNamePublic = "APICover";

    public ScenarioEngine(
        IRuleEvaluator evaluator,
        IBreakpointController breakpoints,
        IRunStore runStore,
        IRunEventBus eventBus,
        IHttpClientFactory httpClientFactory,
        IOptions<APICoverOptions> options,
        ILogger<ScenarioEngine> logger)
    {
        _evaluator = evaluator;
        _breakpoints = breakpoints;
        _runStore = runStore;
        _eventBus = eventBus;
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    public async Task<Run> StartAsync(Scenario scenario, RunOptions? options = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        options ??= new RunOptions();
        var caps = options.BranchCaps ?? BranchCaps.Defaults;

        var run = new Run
        {
            Id = Guid.NewGuid().ToString("N"),
            ScenarioId = scenario.Id,
            Status = RunStatus.Running
        };
        // Note: NodeResults are created lazily via GetOrAddResult as branches reach each node;
        // this avoids stale Pending entries on anchors that fork into per-variant results.

        // Pre-flight branch fan-out check — refuse the run synchronously if it exceeds caps.
        var estimate = BranchEstimator.Estimate(scenario);
        if (estimate.TotalBranches > caps.MaxBranches)
        {
            run.Status = RunStatus.Failed;
            run.Error = $"Branch cap exceeded: estimated {estimate.TotalBranches} branches > limit {caps.MaxBranches}. Reduce variants or raise BranchCaps.MaxBranches.";
            run.CompletedAt = DateTimeOffset.UtcNow;
            await _runStore.SaveAsync(run, cancellationToken).ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent { Type = RunEventType.RunFinished, RunId = run.Id, Payload = run });
            return run;
        }
        if (estimate.TotalLeafInvocations > caps.MaxLeafInvocations)
        {
            run.Status = RunStatus.Failed;
            run.Error = $"Leaf invocation cap exceeded: estimated {estimate.TotalLeafInvocations} HTTP calls > limit {caps.MaxLeafInvocations}. Reduce nodes/variants or raise BranchCaps.MaxLeafInvocations.";
            run.CompletedAt = DateTimeOffset.UtcNow;
            await _runStore.SaveAsync(run, cancellationToken).ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent { Type = RunEventType.RunFinished, RunId = run.Id, Payload = run });
            return run;
        }

        await _runStore.SaveAsync(run, cancellationToken).ConfigureAwait(false);
        _eventBus.Publish(run.Id, new RunEvent
        {
            Type = RunEventType.RunStarted,
            RunId = run.Id,
            Payload = run
        });

        // Fire-and-forget execution; callers observe progress via run/runStore or the SSE event bus.
        _ = Task.Run(() => ExecuteAsync(scenario, run, options, cancellationToken), CancellationToken.None);

        return run;
    }

    private async Task ExecuteAsync(Scenario scenario, Run run, RunOptions options, CancellationToken cancellationToken)
    {
        var nodesById = scenario.Nodes.ToDictionary(n => n.Id, n => n);
        var outgoing = scenario.Edges.GroupBy(e => e.From).ToDictionary(g => g.Key, g => g.ToList());

        var inDegree = new Dictionary<string, int>();
        foreach (var n in scenario.Nodes) inDegree[n.Id] = 0;
        foreach (var e in scenario.Edges) inDegree[e.To] = inDegree.GetValueOrDefault(e.To) + 1;

        IEnumerable<ApiNode> startNodes = scenario.StartNodeIds.Count > 0
            ? scenario.StartNodeIds.Select(id => nodesById[id])
            : scenario.Nodes.Where(n => inDegree[n.Id] == 0);

        var breakpointSet = options.BreakpointsEnabled
            ? scenario.Breakpoints.Where(b => b.Enabled).Select(b => b.NodeId).ToHashSet()
            : new HashSet<string>();

        // Map node id → all execution groups it belongs to (a node may live in multiple).
        var nodeToGroups = new Dictionary<string, List<ExecutionGroup>>(StringComparer.Ordinal);
        foreach (var g in scenario.Groups)
        {
            foreach (var nid in g.NodeIds)
            {
                if (!nodeToGroups.TryGetValue(nid, out var list))
                {
                    list = new List<ExecutionGroup>();
                    nodeToGroups[nid] = list;
                }
                list.Add(g);
            }
        }

        // Cross-branch save serializer; without it concurrent SaveAsync calls from forked
        // branches racing into the same Run document can clobber each other.
        var runStateLock = new SemaphoreSlim(1, 1);
        async Task SaveRun()
        {
            await runStateLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try { await _runStore.SaveAsync(run, cancellationToken).ConfigureAwait(false); }
            finally { runStateLock.Release(); }
        }

        // Per-run runtime caps. Concurrency cap throttles how many variant branches execute
        // simultaneously; leaf invocation counter aborts the run if total HTTP sends ever
        // exceed the configured ceiling (defensive backstop above the pre-flight estimator).
        var caps = options.BranchCaps ?? BranchCaps.Defaults;
        var branchSemaphore = new SemaphoreSlim(Math.Max(1, caps.MaxConcurrentBranches));
        var leafInvocations = 0;
        var leafCapTripped = false;

        // Increments the leaf counter and trips the cap if exceeded. Returns true if the run
        // should abort. Safe to call from any branch.
        bool TryReserveLeaf()
        {
            var n = Interlocked.Increment(ref leafInvocations);
            if (n > caps.MaxLeafInvocations)
            {
                if (!leafCapTripped)
                {
                    leafCapTripped = true;
                    run.Status = RunStatus.Failed;
                    run.Error ??= $"Leaf invocation cap exceeded at runtime ({n} > {caps.MaxLeafInvocations}).";
                }
                return false;
            }
            return true;
        }

        // Root branch state — Step 4 will fork additional states from anchors.
        var rootState = new BranchExecState(
            BranchPath.Root,
            new RunContext { Input = options.Input ?? new JsonObject() },
            new System.Collections.Concurrent.ConcurrentDictionary<string, int>(inDegree),
            new object());

        try
        {
            var startTasks = startNodes.Select(n => RunNode(n, rootState)).ToArray();
            await Task.WhenAll(startTasks).ConfigureAwait(false);

            if (run.Status == RunStatus.Running)
            {
                run.Status = RunStatus.Succeeded;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Run {RunId} failed at top level.", run.Id);
            run.Status = RunStatus.Failed;
            run.Error ??= ex.Message;
        }
        finally
        {
            run.CompletedAt = DateTimeOffset.UtcNow;
            await _runStore.SaveAsync(run, CancellationToken.None).ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.RunFinished,
                RunId = run.Id,
                Payload = run
            });
        }

        async Task RunNode(ApiNode node, BranchExecState st)
        {
            var nodeResult = run.GetOrAddResult(node.Id, st.Path);
            if (nodeResult.Status != NodeStatus.Pending)
            {
                return;
            }

            nodeResult.Status = NodeStatus.Running;
            nodeResult.StartedAt = DateTimeOffset.UtcNow;
            await SaveRun().ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.NodeStarted,
                RunId = run.Id,
                NodeId = node.Id,
                BranchPath = st.Path.Segments.ToList(),
                Payload = nodeResult
            });

            try
            {
                if (node.ShouldRun is not null && !EvaluateShouldRun(node, st.Context))
                {
                    nodeResult.Status = NodeStatus.Skipped;
                    nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                    await SaveRun().ConfigureAwait(false);
                    _eventBus.Publish(run.Id, new RunEvent
                    {
                        Type = RunEventType.NodeCompleted,
                        RunId = run.Id,
                        NodeId = node.Id,
                        BranchPath = st.Path.Segments.ToList(),
                        Payload = nodeResult
                    });
                    await ScheduleSuccessors(node, st);
                    return;
                }

                var request = BuildRequest(node, st.Context, options);

                if (breakpointSet.Contains(node.Id))
                {
                    nodeResult.Status = NodeStatus.Paused;
                    run.PausedAtNodeId = node.Id;
                    run.Status = RunStatus.Paused;
                    await SaveRun().ConfigureAwait(false);
                    _eventBus.Publish(run.Id, new RunEvent
                    {
                        Type = RunEventType.NodePaused,
                        RunId = run.Id,
                        NodeId = node.Id,
                        BranchPath = st.Path.Segments.ToList(),
                        Payload = nodeResult
                    });

                    using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    timeoutCts.CancelAfter(_options.Value.BreakpointTimeout);
                    var decision = await _breakpoints
                        .WaitForDecisionAsync(run.Id, node.Id, request, timeoutCts.Token)
                        .ConfigureAwait(false);

                    run.PausedAtNodeId = null;
                    run.Status = RunStatus.Running;
                    _eventBus.Publish(run.Id, new RunEvent
                    {
                        Type = RunEventType.NodeResumed,
                        RunId = run.Id,
                        NodeId = node.Id,
                        BranchPath = st.Path.Segments.ToList(),
                        Payload = nodeResult
                    });

                    if (decision.Action == BreakpointAction.Abort)
                    {
                        nodeResult.Status = NodeStatus.Cancelled;
                        run.Status = RunStatus.Cancelled;
                        await SkipDescendants(node, st);
                        return;
                    }
                    if (decision.Action == BreakpointAction.Skip)
                    {
                        nodeResult.Status = NodeStatus.Skipped;
                        nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                        await SaveRun().ConfigureAwait(false);
                        await ScheduleSuccessors(node, st);
                        return;
                    }
                    if (decision.EditedRequest is not null)
                    {
                        request = decision.EditedRequest;
                    }
                    nodeResult.Status = NodeStatus.Running;
                }

                nodeResult.Request = request;

                // Case-based branching: if this node is a CaseSet anchor, fork the run into one
                // forked branch per variant. The original (st.Path) NodeResult acts as a
                // dispatch placeholder; per-variant invocations populate their own results
                // tagged with the new branch path.
                var anchorCaseSet = scenario.CaseSets.FirstOrDefault(c => c.AnchorNodeId == node.Id && c.Variants.Count > 0);
                if (anchorCaseSet is not null)
                {
                    nodeResult.Status = NodeStatus.Skipped;
                    nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                    await SaveRun().ConfigureAwait(false);
                    var variantTasks = new List<Task>();
                    foreach (var variant in anchorCaseSet.Variants)
                    {
                        variantTasks.Add(RunVariantBranch(node, request, variant, st));
                    }
                    await Task.WhenAll(variantTasks).ConfigureAwait(false);
                    return;
                }

                ResponseSnapshot response;
                var nodeGroups = nodeToGroups.TryGetValue(node.Id, out var gs) ? gs : null;
                var totalIters = nodeGroups is null ? 1 : nodeGroups.Aggregate(1, (a, g) => a * Math.Max(1, g.Repeat.Count));
                var wasFannedOut = nodeGroups is { Count: > 0 } && totalIters > 1;
                if (wasFannedOut)
                {
                    response = await ExecuteGroupedNodeAsync(node, request, nodeGroups!, nodeResult, run, st, SaveRun, TryReserveLeaf, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    if (!TryReserveLeaf())
                    {
                        nodeResult.Status = NodeStatus.Cancelled;
                        nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                        await SaveRun().ConfigureAwait(false);
                        return;
                    }
                    response = node.Streaming is null
                        ? await SendRequestAsync(request, cancellationToken).ConfigureAwait(false)
                        : await SendStreamingRequestAsync(request, node.Streaming, cancellationToken).ConfigureAwait(false);
                }
                if (!wasFannedOut)
                {
                    nodeResult.Response = response;
                    nodeResult.Status = response.Status >= 200 && response.Status < 400
                        ? NodeStatus.Succeeded
                        : NodeStatus.Failed;
                    nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                }

                lock (st.ContextLock)
                {
                    st.Context.Nodes[node.Id] = new JsonObject
                    {
                        ["request"] = SerializeRequest(request),
                        ["response"] = SerializeResponse(response)
                    };
                }

                await SaveRun().ConfigureAwait(false);
                _eventBus.Publish(run.Id, new RunEvent
                {
                    Type = RunEventType.NodeCompleted,
                    RunId = run.Id,
                    NodeId = node.Id,
                    BranchPath = st.Path.Segments.ToList(),
                    Payload = nodeResult
                });

                if (nodeResult.Status == NodeStatus.Failed)
                {
                    run.Status = RunStatus.Failed;
                    run.Error ??= $"Node '{node.Id}' returned HTTP {response.Status}.";
                    await SkipDescendants(node, st);
                }
                else
                {
                    await ScheduleSuccessors(node, st);
                }
            }
            catch (OperationCanceledException)
            {
                nodeResult.Status = NodeStatus.Cancelled;
                nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                run.Status = RunStatus.Cancelled;
                await SaveRun().ConfigureAwait(false);
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Node {NodeId} failed in run {RunId}.", node.Id, run.Id);
                nodeResult.Status = NodeStatus.Failed;
                nodeResult.Error = ex.Message;
                nodeResult.CompletedAt = DateTimeOffset.UtcNow;
                run.Status = RunStatus.Failed;
                run.Error ??= ex.Message;
                await SaveRun().ConfigureAwait(false);
                await SkipDescendants(node, st);
            }
        }

        async Task RunVariantBranch(ApiNode anchor, RequestSnapshot baseRequest, CaseVariant variant, BranchExecState parentSt)
        {
            // Throttle concurrent forked branches to keep the host from drowning.
            await branchSemaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await RunVariantBranchInner(anchor, baseRequest, variant, parentSt).ConfigureAwait(false);
            }
            finally
            {
                branchSemaphore.Release();
            }
        }

        async Task RunVariantBranchInner(ApiNode anchor, RequestSnapshot baseRequest, CaseVariant variant, BranchExecState parentSt)
        {
            var branchPath = parentSt.Path.Append(variant.Id);
            var variantResult = run.GetOrAddResult(anchor.Id, branchPath);
            variantResult.Status = NodeStatus.Running;
            variantResult.StartedAt = DateTimeOffset.UtcNow;

            // Apply variant overrides onto a cloned request.
            var variantRequest = CloneRequest(baseRequest);
            foreach (var ov in variant.Overrides)
            {
                if (string.IsNullOrEmpty(ov.Field)) continue;
                JsonNode? value;
                if (ov.IsRule && ov.Value is not null)
                {
                    var data = parentSt.Context.ToJson();
                    value = Json.Logic.JsonLogic.Apply(ov.Value.DeepClone(), data);
                }
                else
                {
                    value = ov.Value?.DeepClone();
                }
                ApplyDotPath(variantRequest, ov.Field, value);
            }
            variantResult.Request = variantRequest;

            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.BranchSpawned,
                RunId = run.Id,
                NodeId = anchor.Id,
                BranchPath = branchPath.Segments.ToList(),
                Payload = variantResult
            });
            await SaveRun().ConfigureAwait(false);

            if (!TryReserveLeaf())
            {
                variantResult.Status = NodeStatus.Cancelled;
                variantResult.CompletedAt = DateTimeOffset.UtcNow;
                await SaveRun().ConfigureAwait(false);
                return;
            }

            ResponseSnapshot response;
            try
            {
                response = anchor.Streaming is null
                    ? await SendRequestAsync(variantRequest, cancellationToken).ConfigureAwait(false)
                    : await SendStreamingRequestAsync(variantRequest, anchor.Streaming, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Variant '{Variant}' failed on anchor '{Anchor}' in run {RunId}.",
                    variant.Id, anchor.Id, run.Id);
                variantResult.Status = NodeStatus.Failed;
                variantResult.Error = ex.Message;
                variantResult.CompletedAt = DateTimeOffset.UtcNow;
                run.Status = RunStatus.Failed;
                run.Error ??= ex.Message;
                await SaveRun().ConfigureAwait(false);
                return;
            }

            variantResult.Response = response;
            variantResult.Status = response.Status >= 200 && response.Status < 400
                ? NodeStatus.Succeeded
                : NodeStatus.Failed;
            variantResult.CompletedAt = DateTimeOffset.UtcNow;

            // Build a forked branch state — its context carries this variant's anchor result
            // so downstream nodes resolve `nodes.<anchor>.response.*` against the variant.
            var forkedContext = parentSt.Context.Clone();
            forkedContext.Nodes[anchor.Id] = new JsonObject
            {
                ["request"] = SerializeRequest(variantRequest),
                ["response"] = SerializeResponse(response)
            };
            var forkedInDegree = new System.Collections.Concurrent.ConcurrentDictionary<string, int>(parentSt.InDegreeRemaining);
            var forkedState = new BranchExecState(branchPath, forkedContext, forkedInDegree, new object());

            await SaveRun().ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.NodeCompleted,
                RunId = run.Id,
                NodeId = anchor.Id,
                BranchPath = branchPath.Segments.ToList(),
                Payload = variantResult
            });

            if (variantResult.Status == NodeStatus.Failed)
            {
                run.Status = RunStatus.Failed;
                run.Error ??= $"Variant '{variant.Id}' on '{anchor.Id}' returned HTTP {response.Status}.";
                await SkipDescendants(anchor, forkedState);
            }
            else
            {
                await ScheduleSuccessors(anchor, forkedState);
            }

            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.BranchCompleted,
                RunId = run.Id,
                NodeId = anchor.Id,
                BranchPath = branchPath.Segments.ToList(),
                Payload = variantResult
            });
        }

        async Task ScheduleSuccessors(ApiNode source, BranchExecState st)
        {
            if (!outgoing.TryGetValue(source.Id, out var edges)) return;
            var nextTasks = new List<Task>();
            foreach (var edge in edges)
            {
                var target = nodesById[edge.To];
                if (st.InDegreeRemaining.AddOrUpdate(target.Id, 0, (_, v) => v - 1) == 0)
                {
                    nextTasks.Add(RunNode(target, st));
                }
            }
            if (nextTasks.Count > 0)
            {
                await Task.WhenAll(nextTasks).ConfigureAwait(false);
            }
        }

        async Task SkipDescendants(ApiNode source, BranchExecState st)
        {
            if (!outgoing.TryGetValue(source.Id, out var edges)) return;
            foreach (var edge in edges)
            {
                var target = nodesById[edge.To];
                var targetResult = run.GetOrAddResult(target.Id, st.Path);
                if (targetResult.Status == NodeStatus.Pending)
                {
                    targetResult.Status = NodeStatus.Skipped;
                    targetResult.CompletedAt = DateTimeOffset.UtcNow;
                    await SkipDescendants(target, st);
                }
            }
            await SaveRun().ConfigureAwait(false);
        }
    }

    /// <summary>Per-branch execution state. Each forked branch has its own context, in-degree
    /// remaining map, and context lock so they execute independently of siblings.</summary>
    private sealed class BranchExecState
    {
        public BranchExecState(
            BranchPath path,
            RunContext context,
            System.Collections.Concurrent.ConcurrentDictionary<string, int> inDegreeRemaining,
            object contextLock)
        {
            Path = path;
            Context = context;
            InDegreeRemaining = inDegreeRemaining;
            ContextLock = contextLock;
        }

        public BranchPath Path { get; }
        public RunContext Context { get; }
        public System.Collections.Concurrent.ConcurrentDictionary<string, int> InDegreeRemaining { get; }
        public object ContextLock { get; }
    }

    private bool EvaluateShouldRun(ApiNode node, RunContext context)
    {
        var result = _evaluator.Evaluate(node.ShouldRun, context);
        return result switch
        {
            null => false,
            JsonValue jv when jv.TryGetValue<bool>(out var b) => b,
            JsonValue jv when jv.TryGetValue<string>(out var s) => !string.IsNullOrEmpty(s),
            JsonValue jv when jv.TryGetValue<double>(out var d) => d != 0d,
            JsonObject jo => jo.Count > 0,
            JsonArray ja => ja.Count > 0,
            _ => true
        };
    }

    private RequestSnapshot BuildRequest(ApiNode node, RunContext context, RunOptions options)
    {
        // Path parameter substitution (simple {name} replacement).
        var path = node.Path;
        foreach (var (k, ruleNode) in node.PathParameters)
        {
            var v = _evaluator.EvaluateAsString(ruleNode, context) ?? string.Empty;
            path = path.Replace("{" + k + "}", Uri.EscapeDataString(v), StringComparison.Ordinal);
        }

        // Build query string from node-declared params + run-level (auth) params. Run-level
        // wins on collision so the user can override via the auth modal.
        var queryPairs = new List<string>();
        foreach (var (k, ruleNode) in node.QueryParameters)
        {
            var v = _evaluator.EvaluateAsString(ruleNode, context) ?? string.Empty;
            queryPairs.Add($"{Uri.EscapeDataString(k)}={Uri.EscapeDataString(v)}");
        }
        if (options.QueryParameters is { Count: > 0 } runQuery)
        {
            // Strip any node-level entry sharing the same key so the run-level value wins.
            var nodeKeys = new HashSet<string>(node.QueryParameters.Keys, StringComparer.Ordinal);
            queryPairs.RemoveAll(qp =>
            {
                var eq = qp.IndexOf('=');
                if (eq < 0) return false;
                var key = Uri.UnescapeDataString(qp[..eq]);
                return nodeKeys.Contains(key) && runQuery.ContainsKey(key);
            });
            foreach (var (k, v) in runQuery)
            {
                queryPairs.Add($"{Uri.EscapeDataString(k)}={Uri.EscapeDataString(v ?? string.Empty)}");
            }
        }
        if (queryPairs.Count > 0)
        {
            var qs = string.Join("&", queryPairs);
            path = path.Contains('?', StringComparison.Ordinal) ? $"{path}&{qs}" : $"{path}?{qs}";
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, ruleNode) in node.Headers)
        {
            var v = _evaluator.EvaluateAsString(ruleNode, context);
            if (v is not null) headers[k] = v;
        }
        // Run-level headers (e.g. Authorization) win over node headers.
        if (options.Headers is { Count: > 0 } runHeaders)
        {
            foreach (var (k, v) in runHeaders)
            {
                if (v is not null) headers[k] = v;
            }
        }

        var body = _evaluator.Evaluate(node.Body, context);
        var contentType = node.ContentType ?? (body is null ? null : "application/json");

        return new RequestSnapshot
        {
            Method = node.Method.ToUpperInvariant(),
            Path = path,
            Url = path,
            Headers = headers,
            Body = body,
            ContentType = contentType
        };
    }

    /// <summary>
    /// Replay a node under N&times;M&times;... iterations — the cartesian product of every
    /// group it belongs to. Each iteration emits a single mutated request and is recorded as
    /// its own forked <see cref="NodeResult"/> with a <c>BranchPath</c> ending in
    /// <c>&lt;groupId&gt;#&lt;iter&gt;</c> segments — one per group the node belongs to. The
    /// parent <paramref name="nodeResult"/> is marked <see cref="NodeStatus.Skipped"/> so the
    /// canvas treats it as a dispatch placeholder while the per-iteration records carry the
    /// actual data and feed the BranchTree / branch picker UI.
    /// </summary>
    private async Task<ResponseSnapshot> ExecuteGroupedNodeAsync(
        ApiNode node,
        RequestSnapshot baseRequest,
        IReadOnlyList<ExecutionGroup> nodeGroups,
        NodeResult nodeResult,
        Run run,
        BranchExecState st,
        Func<Task> saveRun,
        Func<bool> tryReserveLeaf,
        CancellationToken cancellationToken)
    {
        var rng = new Random();
        var counts = nodeGroups.Select(g => Math.Max(1, g.Repeat.Count)).ToArray();
        var total = counts.Aggregate(1, (a, b) => a * b);

        // Pre-collect per-node mutations from every group; later we filter by groupId during eval.
        var allMutations = nodeGroups
            .SelectMany(g => g.Mutations
                .Where(m => m.NodeId == node.Id)
                .Select(m => (Group: g, Mutation: m)))
            .ToList();

        // The longest delay among groups gates the inter-iteration pause; advancing the outer
        // loop one tick is conceptually a "complete cycle" across all groups.
        var maxDelay = nodeGroups
            .Select(g => g.Repeat.Delay ?? TimeSpan.Zero)
            .DefaultIfEmpty(TimeSpan.Zero)
            .Max();

        // Parent record acts as a fork-dispatch placeholder; per-iteration records below carry
        // status + response so the branch picker / BranchTree show one chip per iteration.
        nodeResult.Status = NodeStatus.Skipped;
        nodeResult.CompletedAt = DateTimeOffset.UtcNow;
        await saveRun().ConfigureAwait(false);

        ResponseSnapshot? lastResponse = null;
        JsonNode? previousResponseBody = null;
        var indices = new int[counts.Length];

        for (var flat = 0; flat < total; flat++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // Build per-group iteration view (1-based) for the mutation context.
            var groupCtx = new JsonObject();
            for (var i = 0; i < nodeGroups.Count; i++)
            {
                groupCtx[nodeGroups[i].Id] = new JsonObject
                {
                    ["iteration"] = indices[i] + 1,
                    ["total"] = counts[i],
                };
            }

            var ctx = new JsonObject
            {
                ["iteration"] = flat + 1,
                ["total"] = total,
                ["random"] = rng.NextDouble(),
                ["previous"] = previousResponseBody?.DeepClone(),
                ["groups"] = groupCtx,
            };

            // Per-iter branch path: one "<groupId>#<n>" segment per group, in nodeGroups order.
            var baseSegs = st.Path.Segments;
            var iterSegs = new string[baseSegs.Count + nodeGroups.Count];
            for (var i = 0; i < baseSegs.Count; i++) iterSegs[i] = baseSegs[i];
            for (var i = 0; i < nodeGroups.Count; i++)
                iterSegs[baseSegs.Count + i] = $"{nodeGroups[i].Id}#{indices[i] + 1}";
            var iterPath = new BranchPath(iterSegs);

            var iterRequest = CloneRequest(baseRequest);
            foreach (var (g, m) in allMutations)
            {
                if (m.Rule is null) continue;
                // Each mutation also gets a flattened "iteration" matching its own group counter.
                var perGroup = ctx.DeepClone() as JsonObject ?? new JsonObject();
                var idx = -1;
                for (var gi = 0; gi < nodeGroups.Count; gi++) { if (nodeGroups[gi] == g) { idx = gi; break; } }
                if (idx >= 0)
                {
                    perGroup["iteration"] = indices[idx] + 1;
                    perGroup["total"] = counts[idx];
                }
                var value = Json.Logic.JsonLogic.Apply(m.Rule.DeepClone(), perGroup);
                ApplyDotPath(iterRequest, m.Field, value);
            }

            var iterResult = run.GetOrAddResult(node.Id, iterPath);
            iterResult.Status = NodeStatus.Running;
            iterResult.StartedAt = DateTimeOffset.UtcNow;
            iterResult.Request = iterRequest;
            await saveRun().ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.BranchSpawned,
                RunId = run.Id,
                NodeId = node.Id,
                BranchPath = iterPath.Segments.ToList(),
                Payload = iterResult,
            });

            if (!tryReserveLeaf())
            {
                iterResult.Status = NodeStatus.Cancelled;
                iterResult.CompletedAt = DateTimeOffset.UtcNow;
                await saveRun().ConfigureAwait(false);
                _eventBus.Publish(run.Id, new RunEvent
                {
                    Type = RunEventType.NodeCompleted,
                    RunId = run.Id,
                    NodeId = node.Id,
                    BranchPath = iterPath.Segments.ToList(),
                    Payload = iterResult,
                });
                break;
            }

            ResponseSnapshot iterResponse;
            try
            {
                iterResponse = node.Streaming is null
                    ? await SendRequestAsync(iterRequest, cancellationToken).ConfigureAwait(false)
                    : await SendStreamingRequestAsync(iterRequest, node.Streaming, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                iterResult.Status = NodeStatus.Failed;
                iterResult.Error = ex.Message;
                iterResult.CompletedAt = DateTimeOffset.UtcNow;
                await saveRun().ConfigureAwait(false);
                _eventBus.Publish(run.Id, new RunEvent
                {
                    Type = RunEventType.NodeCompleted,
                    RunId = run.Id,
                    NodeId = node.Id,
                    BranchPath = iterPath.Segments.ToList(),
                    Payload = iterResult,
                });
                throw;
            }

            iterResult.Response = iterResponse;
            iterResult.Status = iterResponse.Status >= 200 && iterResponse.Status < 400
                ? NodeStatus.Succeeded
                : NodeStatus.Failed;
            iterResult.CompletedAt = DateTimeOffset.UtcNow;
            await saveRun().ConfigureAwait(false);
            _eventBus.Publish(run.Id, new RunEvent
            {
                Type = RunEventType.NodeCompleted,
                RunId = run.Id,
                NodeId = node.Id,
                BranchPath = iterPath.Segments.ToList(),
                Payload = iterResult,
            });

            lastResponse = iterResponse;
            previousResponseBody = iterResponse.Body;

            // Advance the multi-dimensional counter (innermost varies fastest).
            for (var k = counts.Length - 1; k >= 0; k--)
            {
                indices[k]++;
                if (indices[k] < counts[k]) break;
                indices[k] = 0;
            }

            if (flat + 1 < total && maxDelay > TimeSpan.Zero)
            {
                await Task.Delay(maxDelay, cancellationToken).ConfigureAwait(false);
            }
        }

        return lastResponse!;
    }

    private static RequestSnapshot CloneRequest(RequestSnapshot src) => new()
    {
        Method = src.Method,
        Path = src.Path,
        Url = src.Url,
        Headers = new Dictionary<string, string>(src.Headers, StringComparer.OrdinalIgnoreCase),
        Body = src.Body?.DeepClone(),
        ContentType = src.ContentType,
    };

    /// <summary>
    /// Apply a value at a dot-path inside the request snapshot. Recognised top-level segments:
    /// <c>body.*</c>, <c>headers.*</c>, <c>pathParameters.*</c>, <c>queryParameters.*</c>.
    /// Path/query mutations are reflected onto the URL; everything else writes into the
    /// matching request component.
    /// </summary>
    private static void ApplyDotPath(RequestSnapshot req, string fieldPath, JsonNode? value)
    {
        if (string.IsNullOrEmpty(fieldPath)) return;
        var dot = fieldPath.IndexOf('.');
        var head = dot < 0 ? fieldPath : fieldPath[..dot];
        var tail = dot < 0 ? string.Empty : fieldPath[(dot + 1)..];

        switch (head)
        {
            case "body":
                if (string.IsNullOrEmpty(tail))
                {
                    req.GetType().GetProperty(nameof(RequestSnapshot.Body))!.SetValue(req, value);
                }
                else
                {
                    req.GetType().GetProperty(nameof(RequestSnapshot.Body))!
                        .SetValue(req, SetDeep(req.Body as JsonObject ?? new JsonObject(), tail.Split('.'), value));
                }
                break;
            case "headers":
                if (!string.IsNullOrEmpty(tail))
                {
                    req.Headers[tail] = value?.ToJsonString().Trim('"') ?? string.Empty;
                }
                break;
            case "pathParameters":
                if (!string.IsNullOrEmpty(tail))
                {
                    var v = value?.ToJsonString().Trim('"') ?? string.Empty;
                    var newPath = req.Path.Replace("{" + tail + "}", Uri.EscapeDataString(v), StringComparison.Ordinal);
                    req.GetType().GetProperty(nameof(RequestSnapshot.Path))!.SetValue(req, newPath);
                    req.GetType().GetProperty(nameof(RequestSnapshot.Url))!.SetValue(req, newPath);
                }
                break;
            case "queryParameters":
                if (!string.IsNullOrEmpty(tail))
                {
                    var v = value?.ToJsonString().Trim('"') ?? string.Empty;
                    var sep = req.Path.Contains('?', StringComparison.Ordinal) ? '&' : '?';
                    var qs = $"{Uri.EscapeDataString(tail)}={Uri.EscapeDataString(v)}";
                    var newPath = req.Path + sep + qs;
                    req.GetType().GetProperty(nameof(RequestSnapshot.Path))!.SetValue(req, newPath);
                    req.GetType().GetProperty(nameof(RequestSnapshot.Url))!.SetValue(req, newPath);
                }
                break;
        }
    }

    private static JsonObject SetDeep(JsonObject root, string[] path, JsonNode? value)
    {
        JsonObject current = root;
        for (var i = 0; i < path.Length - 1; i++)
        {
            var key = path[i];
            if (current[key] is JsonObject nested) { current = nested; }
            else
            {
                var fresh = new JsonObject();
                current[key] = fresh;
                current = fresh;
            }
        }
        current[path[^1]] = value?.DeepClone();
        return root;
    }

    private async Task<ResponseSnapshot> SendStreamingRequestAsync(
        RequestSnapshot request,
        StreamingNodeOptions streamingOptions,
        CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);
        // Don't impose the per-request HttpTimeout on a long-lived stream; the StreamProcessor
        // honours streamingOptions.Timeout instead.
        client.Timeout = Timeout.InfiniteTimeSpan;

        using var msg = BuildHttpMessage(request);
        var response = await client.SendAsync(msg, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);

        var responseHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var h in response.Headers) responseHeaders[h.Key] = string.Join(",", h.Value);
        if (response.Content is not null)
        {
            foreach (var h in response.Content.Headers) responseHeaders[h.Key] = string.Join(",", h.Value);
        }

        var contentType = response.Content?.Headers.ContentType?.MediaType;

        JsonNode? body = null;
        if (response.Content is not null)
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            var result = await StreamProcessor.ConsumeAsync(stream, contentType, streamingOptions, _evaluator, cancellationToken).ConfigureAwait(false);
            body = result.Body;
            responseHeaders["X-Utopia-Stream-Messages"] = result.MessageCount.ToString();
            responseHeaders["X-Utopia-Stream-Elapsed"] = result.Elapsed.ToString();
            if (result.MatchedUntil) responseHeaders["X-Utopia-Stream-Until-Matched"] = "true";
        }

        return new ResponseSnapshot
        {
            Status = (int)response.StatusCode,
            Headers = responseHeaders,
            Body = body,
            ContentType = contentType
        };
    }

    private HttpRequestMessage BuildHttpMessage(RequestSnapshot request)
    {
        var msg = new HttpRequestMessage(new HttpMethod(request.Method), request.Path);
        foreach (var (k, v) in request.Headers)
        {
            msg.Headers.TryAddWithoutValidation(k, v);
        }
        if (request.Body is not null)
        {
            var json = request.Body.ToJsonString();
            msg.Content = new StringContent(json, Encoding.UTF8);
            if (!string.IsNullOrEmpty(request.ContentType))
            {
                msg.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(request.ContentType);
            }
        }
        return msg;
    }

    private async Task<ResponseSnapshot> SendRequestAsync(RequestSnapshot request, CancellationToken cancellationToken)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);
        client.Timeout = _options.Value.HttpTimeout;

        using var msg = new HttpRequestMessage(new HttpMethod(request.Method), request.Path);
        foreach (var (k, v) in request.Headers)
        {
            if (!msg.Headers.TryAddWithoutValidation(k, v))
            {
                // Fall through; content headers handled below once content is set.
            }
        }
        if (request.Body is not null)
        {
            var json = request.Body.ToJsonString();
            msg.Content = new StringContent(json, Encoding.UTF8);
            if (!string.IsNullOrEmpty(request.ContentType))
            {
                msg.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(request.ContentType);
            }
        }

        using var response = await client.SendAsync(msg, cancellationToken).ConfigureAwait(false);

        var responseHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var h in response.Headers) responseHeaders[h.Key] = string.Join(",", h.Value);
        if (response.Content is not null)
        {
            foreach (var h in response.Content.Headers) responseHeaders[h.Key] = string.Join(",", h.Value);
        }

        var contentType = response.Content?.Headers.ContentType?.MediaType;
        var bodyText = response.Content is null
            ? null
            : await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        JsonNode? bodyNode = null;
        if (!string.IsNullOrEmpty(bodyText))
        {
            try { bodyNode = JsonNode.Parse(bodyText); }
            catch (JsonException) { bodyNode = JsonValue.Create(bodyText); }
        }

        return new ResponseSnapshot
        {
            Status = (int)response.StatusCode,
            Headers = responseHeaders,
            Body = bodyNode,
            ContentType = contentType
        };
    }

    private static JsonObject SerializeRequest(RequestSnapshot request) => new()
    {
        ["method"] = request.Method,
        ["path"] = request.Path,
        ["url"] = request.Url,
        ["headers"] = HeadersToJson(request.Headers),
        ["body"] = request.Body?.DeepClone()
    };

    private static JsonObject SerializeResponse(ResponseSnapshot response) => new()
    {
        ["status"] = response.Status,
        ["headers"] = HeadersToJson(response.Headers),
        ["body"] = response.Body?.DeepClone()
    };

    private static JsonObject HeadersToJson(IDictionary<string, string> headers)
    {
        var obj = new JsonObject();
        foreach (var (k, v) in headers) obj[k] = v;
        return obj;
    }
}
