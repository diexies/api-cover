using System.Diagnostics;

namespace APICover.Agent.Credentials;

/// <summary>
/// Detects whether the <c>claude</c> CLI (Claude Code) is on PATH. Used by the UI to grey
/// out / enable the "Max subscription" radio in settings. Does NOT call the LLM — just
/// runs <c>claude --version</c> with a short timeout.
/// </summary>
public sealed class MaxSubscriptionProbe
{
    public sealed record ProbeResult(bool Available, string? CliPath, string? Version, string? Error);

    private ProbeResult? _cached;
    private readonly object _lock = new();

    public ProbeResult Probe()
    {
        lock (_lock)
        {
            if (_cached is not null) return _cached;
        }

        var result = RunProbe();
        lock (_lock) _cached = result;
        return result;
    }

    private static ProbeResult RunProbe()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "claude",
                Arguments = "--version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            var stdoutBuf = new System.Text.StringBuilder();
            var stderrBuf = new System.Text.StringBuilder();

            using var proc = new Process { StartInfo = psi };
            proc.OutputDataReceived += (_, e) => { if (e.Data is not null) stdoutBuf.AppendLine(e.Data); };
            proc.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderrBuf.AppendLine(e.Data); };

            if (!proc.Start())
            {
                return new ProbeResult(false, null, null, "Process.Start returned false");
            }
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            if (!proc.WaitForExit(2_000))
            {
                try { proc.Kill(true); } catch { }
                return new ProbeResult(false, null, null, "claude --version timed out");
            }
            // After WaitForExit returns true the async readers may still have a tail to
            // drain — block until they finish their final line.
            proc.WaitForExit();

            if (proc.ExitCode != 0)
            {
                return new ProbeResult(false, null, null, $"claude --version exit {proc.ExitCode}: {stderrBuf.ToString().Trim()}");
            }

            return new ProbeResult(true, "claude", stdoutBuf.ToString().Trim(), null);
        }
        catch (Exception ex)
        {
            return new ProbeResult(false, null, null, ex.Message);
        }
    }
}
