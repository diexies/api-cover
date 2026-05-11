using System.Collections.Concurrent;
using System.Diagnostics;

namespace APICover.Endpoints;

/// <summary>
/// Thin shell-out around <c>git log</c>. Used by the home dashboard's commit timeline.
/// Returns an empty list when the working directory is not a git repo or when git is
/// missing from PATH — the timeline simply hides itself in that case.
/// </summary>
internal static class GitLog
{
    private const char Unit = '';   // %x1f — header field separator
    private const char Record = ''; // %x1e — header / body terminator

    internal sealed record Commit(string Sha, string Subject, string Author, DateTimeOffset Date);

    internal sealed record CommitFile(string Path, string Status, int Additions, int Deletions, string Patch);

    internal sealed record CommitDetail(
        string Sha,
        string Subject,
        string Body,
        string Author,
        DateTimeOffset Date,
        IReadOnlyList<CommitFile> Files);

    public static IReadOnlyList<Commit> Read(string workingDir, int take)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "git",
                WorkingDirectory = workingDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("log");
            psi.ArgumentList.Add("-n");
            psi.ArgumentList.Add(take.ToString());
            psi.ArgumentList.Add($"--pretty=format:%H%x1f%s%x1f%an%x1f%aI");

            using var proc = Process.Start(psi);
            if (proc is null) return Array.Empty<Commit>();
            if (!proc.WaitForExit(5_000))
            {
                try { proc.Kill(true); } catch { }
                return Array.Empty<Commit>();
            }
            if (proc.ExitCode != 0) return Array.Empty<Commit>();
            var stdout = proc.StandardOutput.ReadToEnd();

            var list = new List<Commit>();
            foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Split(Unit);
                if (parts.Length < 4) continue;
                if (!DateTimeOffset.TryParse(parts[3], out var date)) continue;
                list.Add(new Commit(parts[0], parts[1], parts[2], date));
            }
            return list;
        }
        catch
        {
            return Array.Empty<Commit>();
        }
    }

    /// <summary>
    /// Pull metadata + per-file numstat + patch for a single commit. Returns null if
    /// the sha is unknown / git missing / the call exceeds the timeout. Patch text is
    /// truncated per-file at 16 KB so a giant binary diff doesn't blow the response.
    /// Single git invocation (header + --raw + --numstat + -p) keeps click latency low.
    /// </summary>
    public static CommitDetail? ReadCommit(string workingDir, string sha)
    {
        if (string.IsNullOrWhiteSpace(sha)) return null;
        if (sha.Length is < 4 or > 64) return null;
        for (int i = 0; i < sha.Length; i++)
        {
            var c = sha[i];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return null;
        }

        if (Cache.TryGetValue(sha, out var cached)) return cached;

        try
        {
            var combined = RunGit(workingDir, new[]
            {
                "show", "--no-color",
                "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e",
                "--raw", "--numstat", "-p", sha,
            }, 12_000);
            if (combined is null) return null;

            var rsIdx = combined.IndexOf(Record);
            if (rsIdx < 0) return null;
            var headerParts = combined[..rsIdx].Split(Unit);
            if (headerParts.Length < 4) return null;
            if (!DateTimeOffset.TryParse(headerParts[3], out var date)) return null;
            var body = headerParts.Length >= 5 ? headerParts[4].Trim() : string.Empty;

            var rest = combined[(rsIdx + 1)..];

            // Locate the patch boundary first. Everything before is interleaved
            // raw + numstat lines.
            var patchIdx = rest.IndexOf("\ndiff --git ", StringComparison.Ordinal);
            string preamble, patchBlock;
            if (patchIdx >= 0)
            {
                preamble = rest[..patchIdx];
                patchBlock = rest[(patchIdx + 1)..];
            }
            else
            {
                preamble = rest;
                patchBlock = string.Empty;
            }

            var statuses = new Dictionary<string, string>(StringComparer.Ordinal);
            var numstats = new Dictionary<string, (int adds, int dels)>(StringComparer.Ordinal);
            foreach (var line in preamble.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                if (line[0] == ':')
                {
                    var tab = line.IndexOf('\t');
                    if (tab < 0) continue;
                    var meta = line[..tab].Split(' ');
                    if (meta.Length < 5) continue;
                    var status = meta[4].Length > 0 ? meta[4][..1] : "?";
                    statuses[line[(tab + 1)..]] = status;
                }
                else
                {
                    var parts = line.Split('\t');
                    if (parts.Length < 3) continue;
                    int.TryParse(parts[0], out var adds);
                    int.TryParse(parts[1], out var dels);
                    numstats[parts[2]] = (adds, dels);
                }
            }

            var patches = SplitPatches(patchBlock);

            var files = new List<CommitFile>();
            foreach (var (path, (adds, dels)) in numstats)
            {
                statuses.TryGetValue(path, out var status);
                patches.TryGetValue(path, out var patch);
                if (patch is { Length: > 16 * 1024 }) patch = patch[..(16 * 1024)] + "\n… (truncated)";
                files.Add(new CommitFile(path, status ?? "M", adds, dels, patch ?? string.Empty));
            }

            var detail = new CommitDetail(headerParts[0], headerParts[1], body, headerParts[2], date, files);
            Cache[sha] = detail;
            return detail;
        }
        catch
        {
            return null;
        }
    }

    private static readonly ConcurrentDictionary<string, CommitDetail> Cache = new();

    private static string? RunGit(string workingDir, IEnumerable<string> args, int timeoutMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var proc = Process.Start(psi);
        if (proc is null) return null;

        // Drain stdout/stderr concurrently so git can keep writing — otherwise a
        // big diff fills the OS pipe buffer (~64 KB on Linux) and the child blocks
        // forever waiting for us to read, while we sit in WaitForExit. Classic
        // child-process deadlock.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();

        if (!proc.WaitForExit(timeoutMs))
        {
            try { proc.Kill(true); } catch { }
            return null;
        }
        // Ensure async reads observe the closed streams before we touch results.
        try { Task.WaitAll(new Task[] { stdoutTask, stderrTask }, timeoutMs); } catch { }
        if (proc.ExitCode != 0) return null;
        return stdoutTask.IsCompletedSuccessfully ? stdoutTask.Result : null;
    }

    private static Dictionary<string, string> SplitPatches(string fullDiff)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(fullDiff)) return result;

        var chunks = new List<string>();
        var current = new System.Text.StringBuilder();
        foreach (var line in fullDiff.Split('\n'))
        {
            if (line.StartsWith("diff --git ", StringComparison.Ordinal))
            {
                if (current.Length > 0) chunks.Add(current.ToString());
                current.Clear();
            }
            current.Append(line).Append('\n');
        }
        if (current.Length > 0) chunks.Add(current.ToString());

        foreach (var chunk in chunks)
        {
            var firstNl = chunk.IndexOf('\n');
            var header = firstNl > 0 ? chunk[..firstNl] : chunk;
            var bIdx = header.IndexOf(" b/", StringComparison.Ordinal);
            if (bIdx < 0) continue;
            var path = header[(bIdx + 3)..].Trim();
            result[path] = chunk;
        }
        return result;
    }
}
