using System.ComponentModel;
using Microsoft.Extensions.Hosting;
using ModelContextProtocol.Server;
using APICover.Abstractions.Services;
using APICover.Endpoints; // GitLog (internal — InternalsVisibleTo APICover.Mcp)

namespace APICover.Mcp.Tools;

[McpServerToolType]
public static class GitTools
{
    [McpServerTool(Name = "git.commit_impact")]
    [Description("Inspect a commit (files changed, status, +/- counts, per-file unified patch) alongside the workspace's scenario inventory. Returns the diff plus every scenario's endpoint references so the calling LLM can decide which scenarios the commit may have broken or which new ones should be authored.")]
    public static async Task<object> CommitImpact(
        IHostEnvironment env,
        IScenarioStore scenarios,
        [Description("Commit sha (full or short, hex).")] string sha,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(sha))
        {
            throw new ArgumentException("Required field 'sha' is missing.", nameof(sha));
        }
        var detail = GitLog.ReadCommit(env.ContentRootPath, sha);
        if (detail is null)
        {
            return new { error = $"No commit found with sha '{sha}', or git is unavailable." };
        }
        var allScenarios = await scenarios.ListAsync(ct);
        var index = allScenarios.Select(s => new
        {
            id = s.Id,
            name = s.Name,
            endpoints = s.Nodes.Select(n => new { method = n.Method, path = n.Path }).ToArray(),
        }).ToArray();
        return new
        {
            commit = new
            {
                sha = detail.Sha,
                subject = detail.Subject,
                body = detail.Body,
                author = detail.Author,
                date = detail.Date,
                files = detail.Files.Select(f => new
                {
                    path = f.Path,
                    status = f.Status,
                    additions = f.Additions,
                    deletions = f.Deletions,
                    patch = f.Patch,
                }).ToArray(),
            },
            scenarioIndex = index,
        };
    }
}
