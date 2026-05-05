using System.Text;

namespace APICover.Discovery;

/// <summary>
/// Convention fallback for endpoints that carry no explicit <c>[ExploreArea]</c> /
/// <c>[ExploreEndpoint]</c>: derives an area name from a controller's class name by stripping
/// the <c>Controller</c> suffix and converting the remainder to kebab-case.
/// </summary>
internal static class AreaConventionResolver
{
    /// <summary>Returns a kebab-case area name, or <c>null</c> when no convention applies.</summary>
    public static string? FromControllerName(string? controllerName)
    {
        if (string.IsNullOrWhiteSpace(controllerName)) return null;

        var trimmed = controllerName.EndsWith("Controller", StringComparison.Ordinal)
            ? controllerName[..^"Controller".Length]
            : controllerName;

        if (string.IsNullOrEmpty(trimmed)) return null;

        return ToKebabCase(trimmed);
    }

    private static string ToKebabCase(string value)
    {
        var sb = new StringBuilder(value.Length + 4);
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsUpper(c))
            {
                if (i > 0)
                {
                    var prev = value[i - 1];
                    var next = i + 1 < value.Length ? value[i + 1] : '\0';
                    var startOfWord = !char.IsUpper(prev) || (char.IsUpper(prev) && next != '\0' && char.IsLower(next));
                    if (startOfWord)
                    {
                        sb.Append('-');
                    }
                }
                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }
}
