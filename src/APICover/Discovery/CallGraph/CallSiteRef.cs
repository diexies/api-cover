namespace APICover.Discovery.CallGraph;

/// <summary>
/// Canonical formatter for a call-site reference. Produces the <c>Service.Method:Line</c>
/// shape used by both MCP tool output and the UI so the string is greppable / pasteable
/// across surfaces. Null inputs degrade to <c>?</c> tokens so the shape stays stable when
/// PDB metadata is missing.
/// </summary>
public static class CallSiteRef
{
    public static string Format(string? declaringType, string? methodName, int? line)
    {
        var type = Short(declaringType);
        var method = string.IsNullOrEmpty(methodName) ? "?" : methodName;
        var lineStr = line is null ? "?" : line.Value.ToString();
        return $"{type}.{method}:{lineStr}";
    }

    private static string Short(string? fqtn)
    {
        if (string.IsNullOrEmpty(fqtn)) return "?";
        var dot = fqtn.LastIndexOf('.');
        return dot >= 0 ? fqtn[(dot + 1)..] : fqtn;
    }
}
