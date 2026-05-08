namespace APICover.Agent.Memory;

/// <summary>
/// Validates and normalises memory paths. Hard rules: relative only, no <c>..</c>, no
/// absolute, no drive letters, no NUL, only forward slashes, must end in <c>.md</c>,
/// segments must be ASCII letters/digits/dash/underscore. Anything else throws.
/// </summary>
internal static class MemoryPathSandbox
{
    public static string Normalise(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new ArgumentException("Memory path must not be empty.", nameof(input));
        }

        var trimmed = input.Trim().Replace('\\', '/');
        if (trimmed.StartsWith('/'))
        {
            throw new ArgumentException("Memory path must be relative (no leading slash).", nameof(input));
        }
        if (trimmed.Contains('\0'))
        {
            throw new ArgumentException("Memory path must not contain NUL.", nameof(input));
        }
        if (Path.IsPathRooted(trimmed))
        {
            throw new ArgumentException("Memory path must be relative.", nameof(input));
        }

        var segments = trimmed.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0)
        {
            throw new ArgumentException("Memory path must have at least one segment.", nameof(input));
        }
        foreach (var seg in segments)
        {
            if (seg is "." or "..")
            {
                throw new ArgumentException($"Memory path may not contain '{seg}' segments.", nameof(input));
            }
            foreach (var c in seg)
            {
                var ok = c is '-' or '_' or '.' || char.IsAsciiLetterOrDigit(c);
                if (!ok)
                {
                    throw new ArgumentException(
                        $"Memory path segment '{seg}' contains invalid character '{c}'. Allowed: a-z A-Z 0-9 - _ .",
                        nameof(input));
                }
            }
        }

        var lowered = string.Join('/', segments).ToLowerInvariant();
        if (!lowered.EndsWith(".md", StringComparison.Ordinal))
        {
            throw new ArgumentException("Memory paths must end in '.md'.", nameof(input));
        }
        return lowered;
    }

    public static string ResolveAbsolute(string root, string relative)
    {
        var normalised = Normalise(relative);
        var combined = Path.GetFullPath(Path.Combine(root, normalised));
        var rootFull = Path.GetFullPath(root);
        if (!combined.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !string.Equals(combined, rootFull, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Resolved memory path escaped its root.");
        }
        return combined;
    }
}
