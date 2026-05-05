using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Primitives;
using APICover.Abstractions.Discovery;
using APICover.Discovery.Schema;

namespace APICover.Discovery;

/// <summary>
/// Default <see cref="IEndpointDiscoveryService"/> implementation. Walks ASP.NET Core's
/// <see cref="IApiDescriptionGroupCollectionProvider"/> (the same source Swashbuckle uses)
/// and enriches each <see cref="ApiDescription"/> with: parameter validation hints, request /
/// response JSON Schemas, content types, authorization metadata, Utopia <c>Explore*</c> attributes,
/// and a controller-name-derived area fallback.
/// </summary>
public sealed class ApiExplorerDiscoveryService : IEndpointDiscoveryService, IEndpointMethodResolver
{
    private readonly IApiDescriptionGroupCollectionProvider _provider;
    private readonly JsonSchemaGenerator _schemaGenerator;
    private readonly JsonSchemaSampleSynthesizer _sampleSynthesizer;
    private readonly IReadOnlyCollection<EndpointDataSource> _dataSources;
    private readonly object _cacheLock = new();
    private Lazy<IReadOnlyList<EndpointDescriptor>> _cache;
    /// <summary>Endpoint id → handler MethodInfo. Populated as a side-effect of cache build;
    /// surfaced via <see cref="IEndpointMethodResolver"/> for the call-graph walker.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, MethodInfo> _methodById = new();
    private IDisposable? _changeTokenRegistration;
    private int _lastApiVersion = -1;

    public ApiExplorerDiscoveryService(IApiDescriptionGroupCollectionProvider provider)
        : this(provider, Array.Empty<EndpointDataSource>()) { }

    public ApiExplorerDiscoveryService(
        IApiDescriptionGroupCollectionProvider provider,
        IEnumerable<EndpointDataSource> dataSources)
    {
        _provider = provider;
        _schemaGenerator = new JsonSchemaGenerator();
        _sampleSynthesizer = new JsonSchemaSampleSynthesizer();
        _dataSources = dataSources?.ToArray() ?? Array.Empty<EndpointDataSource>();
        _cache = new Lazy<IReadOnlyList<EndpointDescriptor>>(BuildAll, isThreadSafe: true);
        RegisterChangeToken();
    }

    public IReadOnlyList<EndpointDescriptor> GetEndpoints()
    {
        var apiVersion = _provider.ApiDescriptionGroups.Version;
        if (Volatile.Read(ref _lastApiVersion) != apiVersion)
        {
            InvalidateCache();
            Volatile.Write(ref _lastApiVersion, apiVersion);
        }
        return _cache.Value;
    }

    private void InvalidateCache()
    {
        lock (_cacheLock)
        {
            _cache = new Lazy<IReadOnlyList<EndpointDescriptor>>(BuildAll, isThreadSafe: true);
        }
    }

    private void RegisterChangeToken()
    {
        if (_dataSources.Count == 0) return;

        var tokens = _dataSources.Select(ds => ds.GetChangeToken()).ToArray();
        if (tokens.Length == 0) return;

        var composite = new CompositeChangeToken(tokens);
        _changeTokenRegistration?.Dispose();
        _changeTokenRegistration = composite.RegisterChangeCallback(_ =>
        {
            InvalidateCache();
            // Re-arm for the next change cycle.
            RegisterChangeToken();
        }, state: null);
    }

    private IReadOnlyList<EndpointDescriptor> BuildAll()
    {
        var result = new List<EndpointDescriptor>();
        foreach (var group in _provider.ApiDescriptionGroups.Items)
        {
            foreach (var api in group.Items)
            {
                if (TryBuild(api, group.GroupName) is { } descriptor)
                {
                    result.Add(descriptor);
                }
            }
        }
        return result;
    }

    private EndpointDescriptor? TryBuild(ApiDescription api, string? groupName)
    {
        var method = (api.HttpMethod ?? "GET").ToUpperInvariant();
        var rawPath = api.RelativePath?.TrimStart('/') ?? string.Empty;
        // Trim trailing slash so /users and /users/ collapse to a single canonical id.
        if (rawPath.Length > 0 && rawPath[^1] == '/')
        {
            rawPath = rawPath.TrimEnd('/');
        }
        var path = "/" + rawPath;
        var id = $"{method} {path}";

        var metadata = api.ActionDescriptor.EndpointMetadata as IReadOnlyList<object> ?? Array.Empty<object>();

        var classLevelArea = ResolveClassLevelArea(api);
        var enriched = EndpointMetadataReader.Read(metadata, classLevelArea);

        if (enriched.Ignored || enriched.ExcludeFromDescription)
        {
            return null;
        }

        // Side-effect: capture the handler MethodInfo so the call-graph walker can find it
        // by endpoint id without reaching back into IApiDescriptionGroupCollectionProvider.
        var handlerMethod = ResolveHandlerMethod(api);
        if (handlerMethod is not null)
        {
            _methodById[id] = handlerMethod;
        }

        var (parameters, bodyParameter) = BuildParameters(api);

        var requestBody = BuildRequestBody(bodyParameter, enriched.Accepts, api);
        var responses = BuildResponses(api, enriched.ProducesResponses);

        var area = enriched.Area
                   ?? AreaConventionResolver.FromControllerName(GetControllerName(api));

        var sourceKind = ResolveSourceKind(api);
        var handlerTypeName = ResolveHandlerTypeName(api);

        return new EndpointDescriptor
        {
            Id = id,
            Method = method,
            Path = path,
            DisplayName = enriched.DisplayName ?? api.ActionDescriptor.DisplayName,
            GroupName = groupName,
            Area = area,
            Purpose = enriched.Purpose,
            Description = enriched.Description,
            Tags = enriched.Tags,
            IsDeprecated = enriched.IsDeprecated,
            Source = sourceKind,
            HandlerTypeName = handlerTypeName,
            Parameters = parameters,
            RequestBody = requestBody,
            Responses = responses,
            Authorization = enriched.Authorization,
            Samples = enriched.Samples
        };
    }

    private (IReadOnlyList<EndpointParameter> Parameters, ApiParameterDescription? Body) BuildParameters(ApiDescription api)
    {
        var list = new List<EndpointParameter>();
        ApiParameterDescription? body = null;

        foreach (var p in api.ParameterDescriptions)
        {
            if (string.Equals(p.Source.Id, "Body", StringComparison.OrdinalIgnoreCase))
            {
                body ??= p;
                continue;
            }

            var location = MapLocation(p.Source);
            if (location is null) continue;

            list.Add(BuildParameter(p, location.Value));
        }

        return (list, body);
    }

    private EndpointParameter BuildParameter(ApiParameterDescription p, ParameterLocation location)
    {
        var clrType = p.Type ?? p.ModelMetadata?.ModelType;
        var validations = new Dictionary<string, string?>(StringComparer.Ordinal);
        var enumValues = Array.Empty<string>();
        JsonNode? defaultValue = null;

        if (clrType is not null && clrType.IsEnum)
        {
            enumValues = Enum.GetNames(clrType);
        }

        if (p.RouteInfo is not null)
        {
            foreach (var c in p.RouteInfo.Constraints ?? Array.Empty<Microsoft.AspNetCore.Routing.IRouteConstraint>())
            {
                validations[$"route:{c.GetType().Name}"] = null;
            }
        }

        if (p.ModelMetadata?.ValidatorMetadata is { } validators)
        {
            foreach (var v in validators)
            {
                switch (v)
                {
                    case RequiredAttribute:
                        validations["required"] = "true";
                        break;
                    case StringLengthAttribute sl:
                        validations["maxLength"] = sl.MaximumLength.ToString();
                        if (sl.MinimumLength > 0) validations["minLength"] = sl.MinimumLength.ToString();
                        break;
                    case MinLengthAttribute minL:
                        validations["minLength"] = minL.Length.ToString();
                        break;
                    case MaxLengthAttribute maxL:
                        validations["maxLength"] = maxL.Length.ToString();
                        break;
                    case RangeAttribute rng:
                        validations["minimum"] = rng.Minimum?.ToString();
                        validations["maximum"] = rng.Maximum?.ToString();
                        break;
                    case RegularExpressionAttribute regex:
                        validations["pattern"] = regex.Pattern;
                        break;
                }
            }
        }

        if (p.DefaultValue is not null && p.DefaultValue is not DBNull)
        {
            try { defaultValue = JsonValue.Create(p.DefaultValue); } catch { /* unsupported, skip */ }
        }

        JsonNode? schema = null;
        if (clrType is not null)
        {
            try { schema = _schemaGenerator.Generate(clrType); } catch { /* opaque, leave null */ }
        }

        return new EndpointParameter
        {
            Name = p.Name,
            In = location,
            Type = clrType?.Name,
            Required = p.IsRequired || validations.ContainsKey("required"),
            DefaultValue = defaultValue,
            Schema = schema,
            EnumValues = enumValues,
            Validations = validations
        };
    }

    private EndpointRequestBody? BuildRequestBody(
        ApiParameterDescription? bodyParameter,
        Microsoft.AspNetCore.Http.Metadata.IAcceptsMetadata? accepts,
        ApiDescription api)
    {
        Type? bodyType = bodyParameter?.Type ?? bodyParameter?.ModelMetadata?.ModelType ?? accepts?.RequestType;
        var contentTypes = api.SupportedRequestFormats
            .Select(f => f.MediaType)
            .Where(m => !string.IsNullOrWhiteSpace(m))
            .Distinct()
            .ToList();

        if (bodyType is null && accepts is null && contentTypes.Count == 0)
        {
            return null;
        }

        if (contentTypes.Count == 0)
        {
            if (accepts?.ContentTypes is { Count: > 0 } acceptsTypes)
            {
                contentTypes.AddRange(acceptsTypes);
            }
            else if (bodyType is not null)
            {
                contentTypes.Add("application/json");
            }
        }

        JsonNode? schema = null;
        JsonNode? example = null;
        if (bodyType is not null)
        {
            try
            {
                schema = _schemaGenerator.Generate(bodyType);
                example = _sampleSynthesizer.Synthesize(schema);
            }
            catch { /* opaque, leave null */ }
        }

        var media = contentTypes.Select(ct => new EndpointMediaType
        {
            ContentType = ct,
            Schema = schema,
            Example = example
        }).ToList();

        var required = bodyParameter?.IsRequired ?? accepts?.IsOptional == false;

        return new EndpointRequestBody
        {
            Content = media,
            Required = required
        };
    }

    private IReadOnlyList<EndpointResponse> BuildResponses(
        ApiDescription api,
        IReadOnlyList<Microsoft.AspNetCore.Http.Metadata.IProducesResponseTypeMetadata> producesMetadata)
    {
        var byStatus = new Dictionary<int, ResponseAccumulator>();

        foreach (var rt in api.SupportedResponseTypes)
        {
            var entry = GetOrCreate(byStatus, rt.StatusCode);
            entry.ResponseType ??= rt.Type ?? rt.ModelMetadata?.ModelType;
            foreach (var f in rt.ApiResponseFormats)
            {
                if (!string.IsNullOrWhiteSpace(f.MediaType))
                {
                    entry.ContentTypes.Add(f.MediaType);
                }
            }
        }

        foreach (var p in producesMetadata)
        {
            var entry = GetOrCreate(byStatus, p.StatusCode);
            entry.ResponseType ??= p.Type;
            foreach (var ct in p.ContentTypes ?? Array.Empty<string>())
            {
                if (!string.IsNullOrWhiteSpace(ct)) entry.ContentTypes.Add(ct);
            }
        }

        var list = new List<EndpointResponse>(byStatus.Count);
        foreach (var (status, acc) in byStatus.OrderBy(kv => kv.Key))
        {
            JsonNode? schema = null;
            JsonNode? example = null;
            if (acc.ResponseType is not null && acc.ResponseType != typeof(void))
            {
                try
                {
                    schema = _schemaGenerator.Generate(acc.ResponseType);
                    example = _sampleSynthesizer.Synthesize(schema);
                }
                catch { /* opaque */ }
            }

            var contentTypes = acc.ContentTypes.Count == 0 && acc.ResponseType is not null
                ? new HashSet<string> { "application/json" }
                : acc.ContentTypes;

            var media = contentTypes.Select(ct => new EndpointMediaType
            {
                ContentType = ct,
                Schema = schema,
                Example = example,
                Kind = ResponseKindResolver.FromContentType(ct)
            }).ToList();

            var responseKind = ResponseKindResolver.Resolve(acc.ResponseType, media);

            list.Add(new EndpointResponse
            {
                StatusCode = status,
                Content = media,
                Kind = responseKind
            });
        }

        return list;
    }

    private static ResponseAccumulator GetOrCreate(Dictionary<int, ResponseAccumulator> map, int status)
    {
        if (!map.TryGetValue(status, out var acc))
        {
            acc = new ResponseAccumulator();
            map[status] = acc;
        }
        return acc;
    }

    private sealed class ResponseAccumulator
    {
        public Type? ResponseType { get; set; }
        public HashSet<string> ContentTypes { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private static ParameterLocation? MapLocation(BindingSource source)
    {
        if (source == BindingSource.Path) return ParameterLocation.Path;
        if (source == BindingSource.Query) return ParameterLocation.Query;
        if (source == BindingSource.Header) return ParameterLocation.Header;
        if (source == BindingSource.Form || source == BindingSource.FormFile) return ParameterLocation.Form;
        if (source.Id == "Cookie") return ParameterLocation.Cookie;
        return null;
    }

    private static ExploreAreaAttribute? ResolveClassLevelArea(ApiDescription api)
    {
        if (api.ActionDescriptor is ControllerActionDescriptor cad)
        {
            return cad.ControllerTypeInfo.GetCustomAttribute<ExploreAreaAttribute>(inherit: true);
        }
        return null;
    }

    private static EndpointSourceKind ResolveSourceKind(ApiDescription api)
    {
        if (api.ActionDescriptor is ControllerActionDescriptor) return EndpointSourceKind.Controller;
        if (api.ActionDescriptor.EndpointMetadata.OfType<MethodInfo>().Any()) return EndpointSourceKind.MinimalApi;
        return EndpointSourceKind.Unknown;
    }

    private static string? ResolveHandlerTypeName(ApiDescription api)
    {
        if (api.ActionDescriptor is ControllerActionDescriptor cad)
        {
            return $"{cad.ControllerTypeInfo.FullName}.{cad.ActionName}";
        }
        var method = api.ActionDescriptor.EndpointMetadata.OfType<MethodInfo>().FirstOrDefault();
        if (method is not null)
        {
            return $"{method.DeclaringType?.FullName ?? "<anonymous>"}.{method.Name}";
        }
        return api.ActionDescriptor.DisplayName;
    }

    /// <summary>Best-effort lookup of the underlying handler <see cref="MethodInfo"/>. Returns
    /// <c>null</c> for endpoints whose handler can't be resolved (rare — synthetic
    /// minimal-API delegates without metadata).</summary>
    private static MethodInfo? ResolveHandlerMethod(ApiDescription api)
    {
        if (api.ActionDescriptor is ControllerActionDescriptor cad)
        {
            // Match by name only; ASP.NET disallows action overloading by signature within a
            // controller for routing purposes, so this is unambiguous in practice.
            return cad.ControllerTypeInfo
                .GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .FirstOrDefault(m => m.Name == cad.ActionName);
        }
        return api.ActionDescriptor.EndpointMetadata.OfType<MethodInfo>().FirstOrDefault();
    }

    /// <inheritdoc />
    MethodInfo? IEndpointMethodResolver.Resolve(string endpointId)
    {
        // Ensure the cache has been populated at least once so the side-effect ran.
        _ = GetEndpoints();
        return _methodById.TryGetValue(endpointId, out var m) ? m : null;
    }

    private static string? GetControllerName(ApiDescription api)
        => api.ActionDescriptor is ControllerActionDescriptor cad ? cad.ControllerName : null;
}
