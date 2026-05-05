namespace APICover.Abstractions.Models;

/// <summary>
/// Helpers for navigating the flat <see cref="Run.NodeResults"/> list with branch awareness.
/// </summary>
public static class RunExtensions
{
    /// <summary>Find the node result for a specific (nodeId, branchPath). Returns <c>null</c>
    /// if no record exists yet (node not reached on that branch).</summary>
    public static NodeResult? GetResult(this Run run, string nodeId, BranchPath branchPath)
    {
        var key = branchPath.Key;
        for (var i = 0; i < run.NodeResults.Count; i++)
        {
            var r = run.NodeResults[i];
            if (r.NodeId != nodeId) continue;
            if (BranchKey(r) == key) return r;
        }
        return null;
    }

    /// <summary>Find or create the node result entry for (nodeId, branchPath). Newly created
    /// entries start as Pending and are appended to <see cref="Run.NodeResults"/>.</summary>
    public static NodeResult GetOrAddResult(this Run run, string nodeId, BranchPath branchPath)
    {
        var existing = run.GetResult(nodeId, branchPath);
        if (existing is not null) return existing;
        var fresh = new NodeResult
        {
            NodeId = nodeId,
            BranchPath = branchPath.Segments.ToList(),
            Status = NodeStatus.Pending
        };
        run.NodeResults.Add(fresh);
        return fresh;
    }

    /// <summary>True if any record exists for this node on this branch.</summary>
    public static bool HasResult(this Run run, string nodeId, BranchPath branchPath) =>
        run.GetResult(nodeId, branchPath) is not null;

    /// <summary>Wire-format key for a node result's branch path.</summary>
    public static string BranchKey(this NodeResult result) =>
        result.BranchPath.Count == 0 ? string.Empty : string.Join("/", result.BranchPath);
}
