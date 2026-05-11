using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using APICover.Abstractions.Discovery;
using APICover.Abstractions.Services;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// IL-walking call-graph builder. Reads a method's IL bytes via <see cref="IlOpCodeReader"/>,
/// resolves each call's metadata token to a <see cref="MethodBase"/>, classifies the call
/// (interface dispatch, external HTTP boundary, database boundary, framework noise, user
/// code, dynamic, cycle, depth-cap), and recurses into user-code methods. Async / iterator
/// state machines are unwrapped via <see cref="AsyncStateMachineAttribute"/> /
/// <see cref="IteratorStateMachineAttribute"/> so the tree reflects the logical chain rather
/// than the compiler-generated wrapper.
/// </summary>
internal sealed class IlWalker
{
    private readonly IServiceCollectionSnapshot _snapshot;
    private readonly IOptions<APICoverOptions> _options;
    private readonly ILogger<IlWalker> _logger;
    private readonly PdbResolver _pdb;

    public IlWalker(
        IServiceCollectionSnapshot snapshot,
        IOptions<APICoverOptions> options,
        ILogger<IlWalker> logger,
        PdbResolver pdb)
    {
        _snapshot = snapshot;
        _options = options;
        _logger = logger;
        _pdb = pdb;
    }

    /// <summary>Build the full call graph for a single endpoint, rooted at
    /// <paramref name="entry"/>. Returns a populated <see cref="CallGraphNode"/>; walker
    /// errors degrade to <c>Opaque</c> leaves rather than throwing so a single bad method
    /// doesn't tank the whole tree.</summary>
    public CallGraphNode BuildGraph(string endpointId, MethodInfo entry)
    {
        var ctx = new WalkContext(_options.Value.CallGraph, _snapshot, _pdb, _logger);
        var rootCall = ctx.WalkMethod(entry, depth: 0, isRoot: true);

        return new CallGraphNode
        {
            EndpointId = endpointId,
            RootMethod = ctx.FormatDisplay(entry),
            GeneratedAt = DateTimeOffset.UtcNow,
            AssemblyHash = ComputeAssemblyHash(),
            RootCall = rootCall,
            Warnings = ctx.Warnings.AsReadOnly(),
        };
    }

    /// <summary>SHA-256 of the MVID set of every loaded assembly. Cache key — flips when any
    /// host assembly is swapped (deploy / hot reload).</summary>
    private static string ComputeAssemblyHash()
    {
        var sb = new StringBuilder();
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies().OrderBy(a => a.FullName, StringComparer.Ordinal))
        {
            try { sb.Append(asm.ManifestModule.ModuleVersionId.ToString("N")); }
            catch { /* dynamic assemblies have no MVID */ }
        }
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>Per-walk state. Holds the visited set (cycle detection), the warnings list,
    /// and reused config / DI resolver references. One instance per <c>BuildGraph</c> call.</summary>
    private sealed class WalkContext
    {
        private readonly CallGraphInspectionOptions _opts;
        private readonly IServiceCollectionSnapshot _di;
        private readonly PdbResolver _pdb;
        private readonly ILogger _logger;
        private readonly HashSet<string> _visited = new(StringComparer.Ordinal);
        public List<string> Warnings { get; } = new();

        public WalkContext(CallGraphInspectionOptions opts, IServiceCollectionSnapshot di, PdbResolver pdb, ILogger logger)
        {
            _opts = opts;
            _di = di;
            _pdb = pdb;
            _logger = logger;
        }

        /// <summary>Walk one method. Returns a <see cref="CallNode"/> with classified Kind and
        /// any recursed children. Idempotent on early returns (Cycle / DepthCap / Opaque).</summary>
        public CallNode WalkMethod(MethodBase method, int depth, bool isRoot)
        {
            // Async / iterator state-machine unwrap: redirect to MoveNext() so the IL we walk
            // contains the real call sites rather than the state-machine ctor.
            var (effective, asyncTag) = UnwrapStateMachine(method);

            var key = MakeKey(effective);
            if (!isRoot && _visited.Contains(key))
            {
                return Leaf(effective, CallNodeKind.Cycle, notes: "(already visited)");
            }
            if (depth >= _opts.MaxDepth)
            {
                Warnings.Add($"depth cap {_opts.MaxDepth} hit at {key}");
                return Leaf(effective, CallNodeKind.DepthCap);
            }

            byte[]? il;
            try { il = effective.GetMethodBody()?.GetILAsByteArray(); }
            catch { il = null; }

            if (il is null)
            {
                return Leaf(effective, CallNodeKind.Opaque, notes: "(no IL body)");
            }

            _visited.Add(key);
            try
            {
                var children = new List<CallNode>();
                var module = effective.Module;
                Type[]? typeGenericArgs = null;
                Type[]? methodGenericArgs = null;
                try
                {
                    typeGenericArgs = effective.DeclaringType?.IsGenericType == true
                        ? effective.DeclaringType.GetGenericArguments()
                        : null;
                    methodGenericArgs = effective is MethodInfo mi && mi.IsGenericMethod
                        ? mi.GetGenericArguments()
                        : null;
                }
                catch { /* leave nulls */ }

                foreach (var site in IlOpCodeReader.EnumerateCalls(il))
                {
                    MethodBase? called;
                    try { called = module.ResolveMethod(site.MetadataToken, typeGenericArgs, methodGenericArgs); }
                    catch { children.Add(Leaf(null, CallNodeKind.Opaque, notes: $"(unresolved token 0x{site.MetadataToken:X})")); continue; }
                    if (called is null) continue;

                    var classified = Classify(called, depth, module, il, site.IlOffset, effective);
                    if (classified is not null) children.Add(classified);
                }

                // Coalesce consecutive duplicate children (e.g. iter.MoveNext() in a loop).
                var deduped = Dedup(children);

                var (file, line) = _pdb.TryResolve(effective, ilOffset: 0);

                return new CallNode
                {
                    // Display name comes from the ORIGINAL user-visible method, so async
                    // unwraps don't surface "MoveNext" — the user sees CreateInvoiceAsync, not
                    // <CreateInvoiceAsync>d__3.MoveNext.
                    DisplayName = FormatDisplay(method),
                    DeclaringType = method.DeclaringType?.FullName,
                    MethodName = method.Name,
                    ParameterTypes = method.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                    Kind = isRoot ? CallNodeKind.ControllerMethod : CallNodeKind.Method,
                    Notes = asyncTag,
                    FilePath = file,
                    LineNumber = line,
                    Summary = ResolveSummary(method) ?? ResolveSummary(effective),
                    Calls = deduped,
                };
            }
            finally
            {
                _visited.Remove(key);
            }
        }

        /// <summary>Classify a single resolved call site. Returns the child node, or
        /// <c>null</c> if the call is filtered framework noise.</summary>
        private CallNode? Classify(MethodBase called, int parentDepth, Module callerModule, byte[] callerIl, int ilOffset, MethodBase callerForPdb)
        {
            var declaring = called.DeclaringType;

            // 1. External HTTP boundary.
            if (IsHttpBoundary(declaring, called))
            {
                var url = IlOpCodeReader.FindLastLdstrBefore(callerIl, ilOffset, callerModule);
                var (f, l) = _pdb.TryResolve(callerForPdb, ilOffset);
                return Leaf(called, CallNodeKind.ExternalHttp, notes: url is null ? null : $"→ {url}", file: f, line: l);
            }

            // 2. Database boundary.
            if (IsDatabaseBoundary(declaring, called))
            {
                var (f, l) = _pdb.TryResolve(callerForPdb, ilOffset);
                return Leaf(called, CallNodeKind.Database, file: f, line: l);
            }

            // 3. Reflection / dynamic dispatch.
            if (IsDynamic(declaring, called))
            {
                return Leaf(called, CallNodeKind.Dynamic);
            }

            // 4. Framework noise.
            if (IsFrameworkNoise(declaring))
            {
                if (!_opts.IncludeFrameworkCalls) return null;
                return Leaf(called, CallNodeKind.Framework);
            }

            // 5. Interface dispatch.
            if (declaring is { IsInterface: true })
            {
                return WalkInterface(called, declaring, parentDepth);
            }

            // 6. User code — recurse.
            return WalkMethod(called, parentDepth + 1, isRoot: false);
        }

        private CallNode WalkInterface(MethodBase called, Type interfaceType, int parentDepth)
        {
            var hits = _di.ResolveImplementations(interfaceType);
            if (hits.Count == 0)
            {
                return Leaf(called, CallNodeKind.Interface, notes: "(no DI registration)");
            }
            if (hits.Count > 1)
            {
                // Multiple registrations — emit one child per impl, capped at 3.
                var children = new List<CallNode>();
                foreach (var hit in hits.Take(3))
                {
                    children.Add(BuildInterfaceImplChild(called, hit, parentDepth));
                }
                if (hits.Count > 3)
                {
                    children.Add(new CallNode
                    {
                        DisplayName = $"+{hits.Count - 3} more impl(s)",
                        Kind = CallNodeKind.Dynamic,
                    });
                }
                return new CallNode
                {
                    DisplayName = FormatDisplay(called),
                    DeclaringType = interfaceType.FullName,
                    MethodName = called.Name,
                    ParameterTypes = called.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                    Kind = CallNodeKind.Interface,
                    Notes = $"({hits.Count} impls)",
                    Summary = ResolveSummary(called),
                    Calls = children,
                };
            }

            var single = hits[0];
            return BuildInterfaceImplChild(called, single, parentDepth);
        }

        private CallNode BuildInterfaceImplChild(MethodBase ifaceMethod, ServiceRegistration reg, int parentDepth)
        {
            // Factory or instance registration ⇒ body cannot be statically resolved by reading
            // ServiceDescriptor.ImplementationType. Fallback: scan user assemblies for a single
            // concrete type that implements the interface; this catches AddHttpClient<TIface,
            // TImpl> and other typed-factory patterns where the user clearly intends one impl.
            if (reg.HasFactory && reg.ImplementationType is null)
            {
                var fallback = TryFindSingleImplementation(reg.ServiceType);
                if (fallback is not null)
                {
                    return BuildInterfaceImplChildForType(ifaceMethod, fallback, parentDepth, factoryNote: true);
                }
                return new CallNode
                {
                    DisplayName = FormatDisplay(ifaceMethod),
                    DeclaringType = ifaceMethod.DeclaringType?.FullName,
                    MethodName = ifaceMethod.Name,
                    ParameterTypes = ifaceMethod.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                    Kind = CallNodeKind.Interface,
                    Notes = "(factory-resolved)",
                    Summary = ResolveSummary(ifaceMethod),
                    Calls = new[] { Leaf(null, CallNodeKind.Dynamic, notes: "factory delegate body") },
                };
            }
            var implType = reg.ImplementationType ?? reg.ImplementationInstanceType;
            if (implType is null)
            {
                return Leaf(ifaceMethod, CallNodeKind.Interface, notes: "(unresolved)");
            }
            return BuildInterfaceImplChildForType(ifaceMethod, implType, parentDepth, factoryNote: false);
        }

        private CallNode BuildInterfaceImplChildForType(MethodBase ifaceMethod, Type implType, int parentDepth, bool factoryNote)
        {
            // Open-generic registration without a closed-generic context to apply ⇒ leaf.
            if (implType.IsGenericTypeDefinition)
            {
                return new CallNode
                {
                    DisplayName = FormatDisplay(ifaceMethod),
                    DeclaringType = ifaceMethod.DeclaringType?.FullName,
                    MethodName = ifaceMethod.Name,
                    ParameterTypes = ifaceMethod.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                    Kind = CallNodeKind.Interface,
                    ResolvedImplType = implType.FullName + "<>",
                    Notes = "(open-generic impl)",
                    Summary = ResolveSummary(ifaceMethod),
                    Calls = new[] { Leaf(null, CallNodeKind.Dynamic, notes: "open-generic dispatch") },
                };
            }

            // Find the concrete method on the impl by signature match.
            MethodInfo? implMethod = null;
            try
            {
                var paramTypes = ifaceMethod.GetParameters().Select(p => p.ParameterType).ToArray();
                implMethod = implType.GetMethod(
                    ifaceMethod.Name,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic,
                    binder: null,
                    types: paramTypes,
                    modifiers: null);
                if (implMethod is null)
                {
                    // Fallback: any method by name (in case of explicit interface impl naming).
                    implMethod = implType.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic)
                        .FirstOrDefault(m => m.Name == ifaceMethod.Name && m.GetParameters().Length == paramTypes.Length);
                }
            }
            catch { /* leave null */ }

            if (implMethod is null)
            {
                return new CallNode
                {
                    DisplayName = FormatDisplay(ifaceMethod),
                    DeclaringType = ifaceMethod.DeclaringType?.FullName,
                    MethodName = ifaceMethod.Name,
                    ParameterTypes = ifaceMethod.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                    Kind = CallNodeKind.Interface,
                    ResolvedImplType = implType.FullName,
                    Notes = "(impl method not found by signature)",
                    Summary = ResolveSummary(ifaceMethod),
                };
            }

            // Recurse into the impl. Wrap the recursion result as the child of this Interface node.
            var implWalk = WalkMethod(implMethod, parentDepth + 1, isRoot: false);
            return new CallNode
            {
                DisplayName = FormatDisplay(ifaceMethod),
                DeclaringType = ifaceMethod.DeclaringType?.FullName,
                MethodName = ifaceMethod.Name,
                ParameterTypes = ifaceMethod.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList(),
                Kind = CallNodeKind.Interface,
                ResolvedImplType = implType.FullName,
                Notes = factoryNote ? "(factory → " + implType.Name + ")" : null,
                Summary = ResolveSummary(ifaceMethod) ?? ResolveSummary(implMethod),
                Calls = implWalk.Calls.Count == 0 && implWalk.Kind == CallNodeKind.Method
                    ? Array.Empty<CallNode>()
                    : new[] { implWalk },
            };
        }

        /// <summary>Scan loaded assemblies for a single concrete type that implements the
        /// service interface. Matches the <c>AddHttpClient&lt;TIface, TImpl&gt;</c> pattern
        /// (factory delegate but unique impl). Returns <c>null</c> when 0 or &gt;1 candidates
        /// — both are ambiguous so we don't guess.</summary>
        private static Type? TryFindSingleImplementation(Type serviceType)
        {
            if (!serviceType.IsInterface) return null;
            Type? hit = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.IsDynamic) continue;
                Type[] types;
                try { types = asm.GetTypes(); }
                catch { continue; }
                foreach (var t in types)
                {
                    if (t.IsAbstract || t.IsInterface || !t.IsClass) continue;
                    if (!serviceType.IsAssignableFrom(t)) continue;
                    if (hit is not null && hit != t) return null; // ambiguous
                    hit = t;
                }
            }
            return hit;
        }

        // ─── Classification helpers ───────────────────────────────────────────────────

        private static bool IsHttpBoundary(Type? declaring, MethodBase called)
        {
            if (declaring is null) return false;
            // HttpClient / HttpMessageInvoker (and subclasses).
            for (var t = declaring; t is not null; t = t.BaseType)
            {
                if (t.FullName is "System.Net.Http.HttpClient" or "System.Net.Http.HttpMessageInvoker")
                {
                    var n = called.Name;
                    return n is "SendAsync" or "Send" or "GetAsync" or "PostAsync"
                        or "PutAsync" or "PatchAsync" or "DeleteAsync"
                        or "GetStringAsync" or "GetByteArrayAsync" or "GetStreamAsync";
                }
                if (t.FullName == "Grpc.Core.ClientBase") return true;
            }
            // Json convenience extensions ship as static classes (PostAsJsonAsync etc.).
            if (declaring.FullName is "System.Net.Http.Json.HttpClientJsonExtensions"
                or "System.Net.Http.HttpClientExtensions"
                or "System.Net.Http.Json.HttpContentJsonExtensions")
            {
                return true;
            }
            // Refit: the impl assembly is generated at build/start time; its name typically starts
            // with "Refit.". Heuristic.
            var asmName = declaring.Assembly.GetName().Name ?? "";
            if (asmName.StartsWith("Refit.", StringComparison.Ordinal)) return true;
            return false;
        }

        private static bool IsDatabaseBoundary(Type? declaring, MethodBase called)
        {
            if (declaring is null) return false;
            var name = called.Name;
            // EF DbContext.
            for (var t = declaring; t is not null; t = t.BaseType)
            {
                if (t.FullName == "Microsoft.EntityFrameworkCore.DbContext")
                {
                    return name is "SaveChanges" or "SaveChangesAsync"
                        or "Add" or "AddAsync" or "AddRange" or "AddRangeAsync"
                        or "Update" or "UpdateRange"
                        or "Remove" or "RemoveRange";
                }
            }
            // EF DbSet<T>. Catches direct DbSet calls in minimal-API handlers that
            // skip a service layer (e.g. `db.Invoices.FindAsync(id)`). Match by
            // open-generic full name since closed generics produce a string with
            // the type argument suffix.
            for (var t = declaring; t is not null; t = t.BaseType)
            {
                var fn = t.IsGenericType ? t.GetGenericTypeDefinition().FullName : t.FullName;
                if (fn == "Microsoft.EntityFrameworkCore.DbSet`1" || fn == "Microsoft.EntityFrameworkCore.IDbSet`1")
                {
                    return name is "Find" or "FindAsync"
                        or "Add" or "AddAsync" or "AddRange" or "AddRangeAsync"
                        or "Update" or "UpdateRange"
                        or "Remove" or "RemoveRange"
                        or "Attach" or "AttachRange"
                        or "ExecuteDelete" or "ExecuteDeleteAsync"
                        or "ExecuteUpdate" or "ExecuteUpdateAsync";
                }
            }
            // EF queryable extension methods (terminal operators).
            if (declaring.FullName is "Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions")
            {
                return name.EndsWith("Async", StringComparison.Ordinal)
                    || name is "Load" or "LoadAsync";
            }
            // System.Linq queryable terminals — only treat as DB when the queryable's element type
            // belongs to an EF query (we can't tell statically, so be conservative: only flag when
            // the declaring type IS the queryable extensions class).
            if (declaring.FullName is "Microsoft.EntityFrameworkCore.RelationalQueryableExtensions")
            {
                return true;
            }
            // Dapper.
            if ((declaring.Namespace ?? "").StartsWith("Dapper", StringComparison.Ordinal))
            {
                return name.StartsWith("Execute", StringComparison.Ordinal)
                    || name.StartsWith("Query", StringComparison.Ordinal);
            }
            // ADO.NET.
            if (declaring.FullName is "System.Data.Common.DbCommand" or "System.Data.IDbCommand")
            {
                return name is "ExecuteNonQuery" or "ExecuteNonQueryAsync"
                    or "ExecuteReader" or "ExecuteReaderAsync"
                    or "ExecuteScalar" or "ExecuteScalarAsync";
            }
            return false;
        }

        private static bool IsDynamic(Type? declaring, MethodBase called)
        {
            if (declaring is null) return false;
            if (declaring.FullName == "System.Activator" && called.Name == "CreateInstance") return true;
            if (declaring.FullName == "System.Reflection.MethodBase" && called.Name == "Invoke") return true;
            if (declaring.FullName == "System.Linq.Expressions.LambdaExpression" && called.Name == "Compile") return true;
            return false;
        }

        private bool IsFrameworkNoise(Type? declaring)
        {
            if (declaring is null) return true;
            var ns = declaring.Namespace ?? "";
            foreach (var prefix in _opts.NamespaceExcludeList)
            {
                // Match both "Microsoft.EntityFrameworkCore.X" (StartsWith) AND the root namespace
                // itself "Microsoft.EntityFrameworkCore" by stripping the trailing dot when present.
                var trimmed = prefix.TrimEnd('.');
                if (ns == trimmed) return true;
                if (ns.StartsWith(prefix, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        // ─── Async / iterator unwrap ──────────────────────────────────────────────────

        private static (MethodBase Effective, string? AsyncTag) UnwrapStateMachine(MethodBase method)
        {
            var asyncAttr = method.GetCustomAttribute<AsyncStateMachineAttribute>();
            if (asyncAttr?.StateMachineType is { } asyncType)
            {
                var moveNext = asyncType.GetMethod("MoveNext", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (moveNext is not null) return (moveNext, "(async)");
            }
            var iterAttr = method.GetCustomAttribute<IteratorStateMachineAttribute>();
            if (iterAttr?.StateMachineType is { } iterType)
            {
                var moveNext = iterType.GetMethod("MoveNext", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                if (moveNext is not null) return (moveNext, "(iterator)");
            }
            return (method, null);
        }

        // ─── Display + key + leaf helpers ─────────────────────────────────────────────

        public string FormatDisplay(MethodBase m)
        {
            var typeName = SimplifyTypeName(m.DeclaringType?.Name ?? "<anonymous>");
            var methodName = SimplifyTypeName(m.Name);
            // Constructor / static-constructor pseudo-names → friendlier form.
            if (m.Name == ".ctor") return $"new {typeName}()";
            if (m.Name == ".cctor") return $"{typeName} (static init)";
            // Property accessor convention: get_X / set_X → "X (get)" / "X (set)".
            if (methodName.StartsWith("get_", StringComparison.Ordinal))
                return $"{typeName}.{methodName.Substring(4)} (get)";
            if (methodName.StartsWith("set_", StringComparison.Ordinal))
                return $"{typeName}.{methodName.Substring(4)} (set)";
            // Event accessors.
            if (methodName.StartsWith("add_", StringComparison.Ordinal))
                return $"{typeName}.{methodName.Substring(4)} (+=)";
            if (methodName.StartsWith("remove_", StringComparison.Ordinal))
                return $"{typeName}.{methodName.Substring(7)} (-=)";
            return $"{typeName}.{methodName}";
        }

        /// <summary>Strip compiler-generated decoration so async-state-machine display names
        /// like <c>&lt;CreateInvoiceAsync&gt;d__3</c> or nested <c>&lt;&lt;Name&gt;b__0_0&gt;d</c>
        /// collapse to the innermost user-visible method name. Anonymous-type / display-class
        /// names (<c>&lt;&gt;f__…</c>, <c>&lt;&gt;c</c>) become <c>anon</c>.</summary>
        private static string SimplifyTypeName(string name)
        {
            // Innermost <XXX> with no further nesting.
            var m = System.Text.RegularExpressions.Regex.Match(name, "<([^<>]+)>");
            if (m.Success)
            {
                var inner = m.Groups[1].Value;
                return string.IsNullOrEmpty(inner) ? "anon" : inner;
            }
            if (name.StartsWith("<>", StringComparison.Ordinal)) return "anon";
            return name;
        }

        /// <summary>Resolve the human-readable summary from <see cref="ExploreSummaryAttribute"/>:
        /// the method-level attribute wins, then the declaring type's attribute. Returns
        /// <c>null</c> when neither is present.</summary>
        public static string? ResolveSummary(MethodBase? method)
        {
            if (method is null) return null;
            try
            {
                var onMethod = method.GetCustomAttribute<ExploreSummaryAttribute>();
                if (onMethod is not null) return onMethod.Summary;
                var onType = method.DeclaringType?.GetCustomAttribute<ExploreSummaryAttribute>();
                return onType?.Summary;
            }
            catch
            {
                return null;
            }
        }

        private static string MakeKey(MethodBase m)
        {
            var sb = new StringBuilder();
            sb.Append(m.DeclaringType?.FullName ?? "<anonymous>");
            sb.Append('.').Append(m.Name).Append('(');
            var first = true;
            foreach (var p in m.GetParameters())
            {
                if (!first) sb.Append(',');
                sb.Append(p.ParameterType.FullName ?? p.ParameterType.Name);
                first = false;
            }
            sb.Append(')');
            return sb.ToString();
        }

        private CallNode Leaf(MethodBase? method, CallNodeKind kind, string? notes = null, string? file = null, int? line = null)
        {
            return new CallNode
            {
                DisplayName = method is null ? kind.ToString() : FormatDisplay(method),
                DeclaringType = method?.DeclaringType?.FullName,
                MethodName = method?.Name,
                ParameterTypes = method?.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList()
                    ?? (IReadOnlyList<string>)Array.Empty<string>(),
                Kind = kind,
                Notes = notes,
                FilePath = file,
                LineNumber = line,
                Summary = ResolveSummary(method),
            };
        }

        private static IReadOnlyList<CallNode> Dedup(List<CallNode> calls)
        {
            if (calls.Count <= 1) return calls;
            var result = new List<CallNode>(calls.Count);
            CallNode? last = null;
            foreach (var c in calls)
            {
                if (last is not null
                    && last.DeclaringType == c.DeclaringType
                    && last.MethodName == c.MethodName
                    && last.Kind == c.Kind)
                {
                    continue;
                }
                result.Add(c);
                last = c;
            }
            return result;
        }
    }
}
