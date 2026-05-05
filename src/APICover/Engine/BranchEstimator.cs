using APICover.Abstractions.Models;

namespace APICover.Engine;

/// <summary>
/// Pre-flight estimator for case-based branching. Walks the scenario DAG in topological order
/// and computes how many branches the engine will create at each leaf, plus the total HTTP
/// invocation count across all branches. Used by <see cref="ScenarioEngine.StartAsync"/> to
/// reject runs whose fan-out exceeds <see cref="BranchCaps.MaxBranches"/> or
/// <see cref="BranchCaps.MaxLeafInvocations"/>.
/// </summary>
public static class BranchEstimator
{
    /// <summary>Aggregate fan-out estimate for a scenario.</summary>
    public readonly record struct EstimateResult(int TotalBranches, int TotalLeafInvocations);

    /// <summary>
    /// Compute the estimate. Algorithm:
    /// <list type="bullet">
    /// <item>Topo-sort nodes.</item>
    /// <item>Each node's branch count = max(branch count of its predecessors) (joins converge,
    /// they don't multiply within a branch).</item>
    /// <item>If a node is the anchor of a CaseSet, multiply outgoing branch count by
    /// <c>Variants.Count</c>.</item>
    /// <item>Total branches = sum of branch counts at sink (no-outgoing) nodes, capped at 1
    /// when the scenario has no nodes at all.</item>
    /// <item>Leaf invocations = sum of branch counts across all nodes (each node executes once
    /// per branch).</item>
    /// </list>
    /// </summary>
    public static EstimateResult Estimate(Scenario scenario)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        if (scenario.Nodes.Count == 0) return new EstimateResult(0, 0);

        // Map: node id → list of incoming sources, list of outgoing targets, anchor variant count.
        var incoming = scenario.Nodes.ToDictionary(n => n.Id, _ => new List<string>());
        var outgoing = scenario.Nodes.ToDictionary(n => n.Id, _ => new List<string>());
        foreach (var e in scenario.Edges)
        {
            // Guard both endpoints — drop edges that reference unknown ids (e.g. stale
            // synthetic per-branch fan-out edges that leaked into a saved scenario before
            // the UI started filtering them).
            if (!incoming.ContainsKey(e.To) || !outgoing.ContainsKey(e.From)) continue;
            incoming[e.To].Add(e.From);
            outgoing[e.From].Add(e.To);
        }

        // Anchor variant counts (multiply downstream when a CaseSet is attached).
        var variantCount = new Dictionary<string, int>();
        foreach (var c in scenario.CaseSets)
        {
            // Skip CaseSets whose anchor isn't in the graph (defensive).
            if (!outgoing.ContainsKey(c.AnchorNodeId)) continue;
            // 0 variants ≡ no fork (no-op); 1 variant ≡ 1× (also no-op).
            variantCount[c.AnchorNodeId] = Math.Max(variantCount.GetValueOrDefault(c.AnchorNodeId, 1), c.Variants.Count == 0 ? 1 : c.Variants.Count);
        }

        // Kahn's algorithm topo sort.
        var inDegree = scenario.Nodes.ToDictionary(n => n.Id, n => incoming[n.Id].Count);
        var queue = new Queue<string>(scenario.Nodes.Where(n => inDegree[n.Id] == 0).Select(n => n.Id));
        var topo = new List<string>(scenario.Nodes.Count);
        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            topo.Add(id);
            foreach (var t in outgoing[id])
            {
                if (--inDegree[t] == 0) queue.Enqueue(t);
            }
        }
        // If the graph has cycles, fall back to scenario.Nodes order — estimator is conservative.
        if (topo.Count != scenario.Nodes.Count)
        {
            return new EstimateResult(int.MaxValue, int.MaxValue);
        }

        // Compute branch count per node.
        var branches = new Dictionary<string, long>();
        foreach (var n in scenario.Nodes) branches[n.Id] = incoming[n.Id].Count == 0 ? 1L : 0L;

        long totalLeafInvocations = 0;
        foreach (var id in topo)
        {
            // Branch count entering this node = max over predecessors. Sources stay at 1.
            var preds = incoming[id];
            if (preds.Count > 0)
            {
                long max = 0;
                foreach (var p in preds) if (branches[p] > max) max = branches[p];
                branches[id] = max;
            }

            // After execution, multiply by variant count if this node anchors a CaseSet. The
            // multiplication propagates to successors (we update branches[id] in place; the
            // successor max() picks it up).
            if (variantCount.TryGetValue(id, out var vc) && vc > 1)
            {
                branches[id] = branches[id] * vc;
            }

            totalLeafInvocations += branches[id];
            // Saturate to avoid overflow on pathological scenarios.
            if (totalLeafInvocations > int.MaxValue) totalLeafInvocations = int.MaxValue;
        }

        // Total branches = sum over sink nodes (no outgoing edges).
        long totalBranches = 0;
        foreach (var id in topo)
        {
            if (outgoing[id].Count == 0)
            {
                totalBranches += branches[id];
                if (totalBranches > int.MaxValue) totalBranches = int.MaxValue;
            }
        }
        // If every node has outgoing (cycle-free + no sink, e.g. single isolated node with self-edge
        // — already caught above), fall back to the deepest branch count.
        if (totalBranches == 0) totalBranches = branches.Values.DefaultIfEmpty(1).Max();

        return new EstimateResult((int)totalBranches, (int)totalLeafInvocations);
    }
}
