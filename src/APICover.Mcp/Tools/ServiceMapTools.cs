using System.ComponentModel;
using ModelContextProtocol.Server;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;
using APICover.Discovery.CallGraph;

namespace APICover.Mcp.Tools;

/// <summary>
/// Discovery surface for LLMs: caller lists with file:line precision, per-node metrics,
/// and aggregate hotspot summaries. Lets an agent consult the call graph BEFORE editing
/// a service so its proposed change accounts for every caller and metric impact.
/// </summary>
[McpServerToolType]
public static class ServiceMapTools
{
    [McpServerTool(Name = "service.callers")]
    [Description("WHEN: about to edit a service / interface and need to know every caller's file:line before refactoring. Returns ServiceCatalog reverse-fan-in for the given declaring type.\n\nResponse: { serviceId, shortName, resolvedImpl, callSites:[{ ref: \"WorkflowService.RejectAsync:142\", id, filePath, line, endLine, methodName, summary, snippet }], directCallers:[{ endpointId, via[], callSites }], methodCallers{} }.")]
    public static async Task<object> Callers(
        IReverseCallIndexService reverse,
        [Description("Fully-qualified declaring type, e.g. \"PVC.Modules.Workflow.Application.Services.WorkflowService\".")] string id,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var dto = await reverse.GetCallersAsync(id, ct);
        if (dto is null) return new { error = $"No callers indexed for service '{id}'." };

        var callSites = dto.CallerServices.Select(c => new
        {
            @ref = CallSiteRef.Format(c.Id, c.MethodName, c.LineNumber),
            id = c.Id,
            shortName = c.ShortName,
            filePath = c.FilePath,
            line = c.LineNumber,
            endLine = c.EndLine,
            methodName = c.MethodName,
            summary = c.Summary,
            snippet = c.BodySnippet,
            calledByEndpoints = c.CalledByEndpoints,
        }).ToArray();

        return new
        {
            serviceId = dto.ServiceId,
            shortName = dto.ShortName,
            isInterface = dto.IsInterface,
            resolvedImpl = dto.ResolvedImplType,
            transitiveEndpointCount = dto.TransitiveEndpointCount,
            callSites,
            directCallers = dto.DirectCallers.Select(d => new
            {
                endpointId = d.EndpointId,
                via = d.Via,
                callSites = d.CallSites,
            }).ToArray(),
            methodCallers = dto.MethodCallers.ToDictionary(kv => kv.Key, kv => kv.Value),
        };
    }

    [McpServerTool(Name = "method.impact")]
    [Description("WHEN: BEFORE editing any method body. ALWAYS call this first to see who breaks if you change it and what it depends on. Returns callers (who calls this method, with file:line) + callees (what this method calls) + endpoints that transitively reach it. If callSites > 0, your edit affects every caller — read each one before changing the signature/behavior. If callees include external services or DB calls, your edit may break downstream contracts.\n\nResponse: { declaringType, methodName, shortName, callSites:[{ ref, callerType, callerMethod, filePath, line, endLine, summary, snippet, calledByEndpoints[] }], directCallers:[{ endpointId, via[], callSites }], callees:[{ ref, calleeType, calleeMethod, kind, resolvedImpl, filePath, line, endLine, summary }], totalCallSites, transitiveEndpointCount }.")]
    public static async Task<object> MethodImpact(
        IReverseCallIndexService reverse,
        [Description("Fully-qualified declaring type of the target method.")] string type,
        [Description("Method name (no parameters), e.g. \"GetPendingPriceListsCountAsync\".")] string method,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(type))
        {
            throw new ArgumentException("Required field 'type' is missing.", nameof(type));
        }
        if (string.IsNullOrWhiteSpace(method))
        {
            throw new ArgumentException("Required field 'method' is missing.", nameof(method));
        }
        var dto = await reverse.GetMethodCallersAsync(type, method, ct);
        if (dto is null) return new { error = $"No callers indexed for '{type}.{method}'." };
        return new
        {
            declaringType = dto.DeclaringType,
            methodName = dto.MethodName,
            shortName = dto.ShortName,
            totalCallSites = dto.TotalCallSites,
            transitiveEndpointCount = dto.TransitiveEndpointCount,
            callSites = dto.CallSites.Select(s => new
            {
                @ref = s.Ref,
                callerType = s.CallerType,
                callerMethod = s.CallerMethod,
                filePath = s.FilePath,
                line = s.LineNumber,
                endLine = s.EndLine,
                summary = s.Summary,
                snippet = s.BodySnippet,
                calledByEndpoints = s.CalledByEndpoints,
            }).ToArray(),
            directCallers = dto.DirectCallers.Select(d => new
            {
                endpointId = d.EndpointId,
                via = d.Via,
                callSites = d.CallSites,
            }).ToArray(),
            callees = dto.Callees.Select(c => new
            {
                @ref = c.Ref,
                calleeType = c.CalleeType,
                calleeMethod = c.CalleeMethod,
                kind = c.Kind,
                resolvedImpl = c.ResolvedImplType,
                filePath = c.FilePath,
                line = c.LineNumber,
                endLine = c.EndLine,
                summary = c.Summary,
            }).ToArray(),
        };
    }

    [McpServerTool(Name = "service.usage")]
    [Description("WHEN: need aggregate usage stats for a service — how many endpoints reach it, which methods are actually called, total call sites. Wraps ServiceCatalog.ServiceUsageEntry plus computed distinct counts.\n\nResponse: { declaringType, shortName, isInterface, resolvedImpl, usedByEndpoints[], calledMethods[], totalCallSites, distinctCallerEndpoints, distinctMethodsInvoked }.")]
    public static async Task<object> Usage(
        IServiceCatalogService catalog,
        [Description("Fully-qualified declaring type.")] string id,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var cat = await catalog.BuildAsync(ct);
        var entry = cat.Services.FirstOrDefault(s => s.DeclaringType == id);
        if (entry is null) return new { error = $"No service entry for '{id}'." };
        return new
        {
            declaringType = entry.DeclaringType,
            shortName = entry.ShortName,
            isInterface = entry.IsInterface,
            resolvedImpl = entry.ResolvedImplType,
            usedByEndpoints = entry.UsedByEndpoints,
            calledMethods = entry.CalledMethods,
            totalCallSites = entry.TotalCallSites,
            distinctCallerEndpoints = entry.UsedByEndpoints.Count,
            distinctMethodsInvoked = entry.CalledMethods.Count,
        };
    }

    [McpServerTool(Name = "service.metrics")]
    [Description("WHEN: weighing impact of a change — pull coupling, fan-in/out, depth, instability for any node (service or endpoint). Single-node metric block.\n\nResponse: { id, kind, label, level, islandIndex, isIsolated, metrics:{ fanIn, fanOut, depth, externalReach, databaseReach, serviceReach, siblingEndpoints, instability, coupling } }.")]
    public static async Task<object> Metrics(
        IServiceMapService mapService,
        [Description("Node id — service FQTN, endpoint 'METHOD /path', or boundary 'http:'/'db:' id.")] string id,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var map = await mapService.BuildAsync(ct);
        var node = map.Nodes.FirstOrDefault(n => n.Id == id);
        if (node is null) return new { error = $"No service map node with id '{id}'." };
        return new
        {
            id = node.Id,
            kind = node.Kind.ToString(),
            label = node.Label,
            fullName = node.FullName,
            level = node.Level,
            islandIndex = node.IslandIndex,
            isIsolated = node.IsIsolated,
            metrics = ProjectMetrics(node.Metrics),
        };
    }

    [McpServerTool(Name = "service.map.summary")]
    [Description("WHEN: orienting in a new codebase — single-shot overview of the system: counts, top hotspots, island sizes. Cheap call.\n\nResponse: { counts, topCoupled[10], topFanIn[10], topDepth[10], topServiceReach[10], islandsBySize[5] }.")]
    public static async Task<object> Summary(
        IServiceMapService mapService,
        CancellationToken ct)
    {
        var map = await mapService.BuildAsync(ct);
        var counts = new
        {
            endpoints = map.Nodes.Count(n => n.Kind == ServiceMapNodeKind.Endpoint),
            services = map.Nodes.Count(n => n.Kind == ServiceMapNodeKind.Service),
            externalHttp = map.Nodes.Count(n => n.Kind == ServiceMapNodeKind.ExternalHttp),
            databases = map.Nodes.Count(n => n.Kind == ServiceMapNodeKind.Database),
            islands = map.Islands.Count,
            isolated = map.Nodes.Count(n => n.IsIsolated),
            edges = map.Edges.Count,
        };
        return new
        {
            generatedAt = map.GeneratedAt,
            counts,
            topCoupled = Top(map, m => m.Coupling, 10),
            topFanIn = Top(map, m => m.FanIn, 10),
            topDepth = Top(map, m => m.Depth, 10),
            topServiceReach = Top(map, m => m.ServiceReach, 10),
            islandsBySize = map.Islands
                .Select((ids, idx) => new { index = idx, size = ids.Count, sample = ids.Take(5).ToArray() })
                .OrderByDescending(x => x.size).Take(5).ToArray(),
        };
    }

    [McpServerTool(Name = "service.map.top")]
    [Description("WHEN: asking 'show top N hot services / endpoints by coupling/fanIn/depth' to triage refactor candidates. Sorted slice over the service map.\n\nResponse: { metric, take, kind?, items:[{ id, kind, label, fullName, metrics }] }.")]
    public static async Task<object> Top(
        IServiceMapService mapService,
        [Description("Metric to sort by — coupling | fanIn | fanOut | depth | externalReach | databaseReach | serviceReach | siblingEndpoints | instability.")] string metric,
        CancellationToken ct,
        [Description("Number of rows to return (default 20).")] int take = 20,
        [Description("Optional node kind filter — endpoint | service | externalHttp | database.")] string? kind = null)
    {
        if (string.IsNullOrWhiteSpace(metric))
        {
            throw new ArgumentException("Required field 'metric' is missing.", nameof(metric));
        }
        var map = await mapService.BuildAsync(ct);
        IEnumerable<ServiceMapNode> nodes = map.Nodes;
        if (!string.IsNullOrEmpty(kind))
        {
            if (!Enum.TryParse<ServiceMapNodeKind>(kind, ignoreCase: true, out var k))
            {
                return new { error = $"Unknown kind '{kind}'. Use endpoint | service | externalHttp | database." };
            }
            nodes = nodes.Where(n => n.Kind == k);
        }
        Func<ServiceMapMetrics, double> selector = metric.ToLowerInvariant() switch
        {
            "coupling" => m => m.Coupling,
            "fanin" => m => m.FanIn,
            "fanout" => m => m.FanOut,
            "depth" => m => m.Depth,
            "externalreach" => m => m.ExternalReach,
            "databasereach" => m => m.DatabaseReach,
            "servicereach" => m => m.ServiceReach,
            "siblingendpoints" => m => m.SiblingEndpoints,
            "instability" => m => m.Instability ?? -1,
            _ => null!
        };
        if (selector is null)
        {
            return new { error = $"Unknown metric '{metric}'." };
        }
        var items = nodes
            .OrderByDescending(n => selector(n.Metrics))
            .Take(Math.Clamp(take, 1, 200))
            .Select(n => new
            {
                id = n.Id,
                kind = n.Kind.ToString(),
                label = n.Label,
                fullName = n.FullName,
                metrics = ProjectMetrics(n.Metrics),
            })
            .ToArray();
        return new { metric, take, kind, items };
    }

    [McpServerTool(Name = "endpoint.callgraph")]
    [Description("WHEN: need the full call tree under an endpoint — every method, file:line, summary, signals. Use to trace 'what does this endpoint touch end-to-end'. Truncates by depth to keep payload manageable.\n\nResponse: { endpointId, rootMethod, generatedAt, truncated, rootCall:CallNode } where CallNode = { displayName, declaringType, methodName, kind, resolvedImpl, filePath, line, endLine, summary, signals, calls[] }.")]
    public static async Task<object> CallGraph(
        ICallGraphService callGraphs,
        [Description("Endpoint id in the form \"METHOD /path\".")] string id,
        CancellationToken ct,
        [Description("Max recursion depth (default 4). Children deeper than this are dropped with truncated=true.")] int maxDepth = 4)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("Required field 'id' is missing.", nameof(id));
        }
        var graph = await callGraphs.GetForEndpointAsync(id, ct);
        if (graph is null) return new { error = $"No call graph for endpoint '{id}'." };
        var depth = Math.Clamp(maxDepth, 1, 12);
        var truncated = false;
        var root = ProjectCallNode(graph.RootCall, 0, depth, ref truncated);
        return new
        {
            endpointId = graph.EndpointId,
            rootMethod = graph.RootMethod,
            generatedAt = graph.GeneratedAt,
            warnings = graph.Warnings,
            maxDepth = depth,
            truncated,
            rootCall = root,
        };
    }

    private static object ProjectMetrics(ServiceMapMetrics m) => new
    {
        fanIn = m.FanIn,
        fanOut = m.FanOut,
        depth = m.Depth,
        externalReach = m.ExternalReach,
        databaseReach = m.DatabaseReach,
        serviceReach = m.ServiceReach,
        siblingEndpoints = m.SiblingEndpoints,
        instability = m.Instability,
        coupling = m.Coupling,
    };

    private static object[] Top(ServiceMap map, Func<ServiceMapMetrics, double> sel, int take) =>
        map.Nodes
            .OrderByDescending(n => sel(n.Metrics))
            .Take(take)
            .Select(n => new
            {
                id = n.Id,
                kind = n.Kind.ToString(),
                label = n.Label,
                value = sel(n.Metrics),
            })
            .ToArray<object>();

    private static object ProjectCallNode(CallNode node, int depth, int maxDepth, ref bool truncated)
    {
        if (depth >= maxDepth && node.Calls.Count > 0)
        {
            truncated = true;
            return new
            {
                @ref = CallSiteRef.Format(node.DeclaringType, node.MethodName, node.LineNumber),
                displayName = node.DisplayName,
                declaringType = node.DeclaringType,
                methodName = node.MethodName,
                kind = node.Kind.ToString(),
                resolvedImpl = node.ResolvedImplType,
                filePath = node.FilePath,
                line = node.LineNumber,
                endLine = node.EndLine,
                summary = node.Summary,
                childrenTruncated = node.Calls.Count,
            };
        }
        var children = new List<object>(node.Calls.Count);
        foreach (var c in node.Calls)
        {
            children.Add(ProjectCallNode(c, depth + 1, maxDepth, ref truncated));
        }
        return new
        {
            @ref = CallSiteRef.Format(node.DeclaringType, node.MethodName, node.LineNumber),
            displayName = node.DisplayName,
            declaringType = node.DeclaringType,
            methodName = node.MethodName,
            kind = node.Kind.ToString(),
            resolvedImpl = node.ResolvedImplType,
            filePath = node.FilePath,
            line = node.LineNumber,
            endLine = node.EndLine,
            summary = node.Summary,
            signals = node.Signals?.Select(s => new { kind = s.Kind.ToString(), text = s.Text }).ToArray(),
            calls = children,
        };
    }
}
