using System.Text.Json;
using System.Text.RegularExpressions;
using APICover.Abstractions.Models;

namespace APICover.Abstractions.Validation;

public sealed record CustomToolValidationResult(bool IsValid, IReadOnlyList<string> Errors);

/// <summary>
/// Validates user-submitted <see cref="CustomToolDefinition"/> records. Pure static, never
/// throws — accumulates every problem so the UI can render them all at once. Rejects
/// absolute URL templates as an SSRF guard: only relative paths against the host are
/// permitted.
/// </summary>
public static class CustomToolValidator
{
    private static readonly Regex NameRe = new("^[a-z0-9._-]+$", RegexOptions.Compiled);
    private static readonly HashSet<string> AllowedMethods = new(StringComparer.OrdinalIgnoreCase)
    {
        "GET", "POST", "PUT", "PATCH", "DELETE"
    };
    private static readonly Regex PlaceholderRe = new(@"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}", RegexOptions.Compiled);

    public static CustomToolValidationResult Validate(CustomToolDefinition def)
    {
        var errors = new List<string>();
        if (def is null)
        {
            errors.Add("definition is null.");
            return new CustomToolValidationResult(false, errors);
        }

        // Name
        if (string.IsNullOrWhiteSpace(def.Name))
        {
            errors.Add("name is required.");
        }
        else
        {
            if (def.Name.Length < 3 || def.Name.Length > 64)
                errors.Add("name must be 3..64 characters long.");
            if (!NameRe.IsMatch(def.Name))
                errors.Add("name must match ^[a-z0-9._-]+$ (lowercase, digits, dot, hyphen, underscore).");
        }

        if (string.IsNullOrWhiteSpace(def.Description))
            errors.Add("description is required.");
        if (string.IsNullOrWhiteSpace(def.WhenTriggered))
            errors.Add("whenTriggered is required.");

        // Method
        if (string.IsNullOrWhiteSpace(def.Method) || !AllowedMethods.Contains(def.Method))
            errors.Add($"method must be one of GET, POST, PUT, PATCH, DELETE (got '{def.Method}').");

        // UrlTemplate — SSRF guard
        if (string.IsNullOrWhiteSpace(def.UrlTemplate))
        {
            errors.Add("urlTemplate is required.");
        }
        else
        {
            var url = def.UrlTemplate;
            if (!url.StartsWith("/", StringComparison.Ordinal))
                errors.Add("urlTemplate must be a relative path starting with /.");
            else if (url.StartsWith("//", StringComparison.Ordinal))
                errors.Add("urlTemplate must not start with // (protocol-relative URLs are rejected).");
            else if (url.Contains(".."))
                errors.Add("urlTemplate must not contain .. segments.");
            else
            {
                // Strip {{paramName}} placeholders to ensure the underlying shape is a well-formed path.
                var stripped = PlaceholderRe.Replace(url, "x");
                if (!Uri.IsWellFormedUriString(stripped, UriKind.Relative))
                    errors.Add("urlTemplate is not a well-formed relative URI.");
            }
        }

        // ParamsSchema shape: object with .properties map.
        if (def.ParamsSchema.ValueKind != JsonValueKind.Object)
        {
            errors.Add("paramsSchema must be a JSON object.");
        }
        else if (def.ParamsSchema.TryGetProperty("properties", out var props))
        {
            if (props.ValueKind != JsonValueKind.Object)
                errors.Add("paramsSchema.properties must be an object.");
        }

        return new CustomToolValidationResult(errors.Count == 0, errors);
    }
}
