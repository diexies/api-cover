using System.Text.RegularExpressions;
using APICover.Abstractions.Models;

namespace APICover.Abstractions.Validation;

public sealed record ScenarioValidationResult(bool IsValid, IReadOnlyList<string> Errors);

/// <summary>
/// Structural validator for a deserialized <see cref="Scenario"/>. Collects every problem,
/// never throws. Reused by both MCP scenarios.save and the agent save_scenario tool.
/// </summary>
public static class ScenarioValidator
{
    private static readonly Regex IdPattern = new("^[a-z0-9-]+$", RegexOptions.Compiled);

    public static ScenarioValidationResult Validate(Scenario scenario)
    {
        if (scenario is null)
        {
            return new ScenarioValidationResult(false, new[] { "scenario is null" });
        }

        var errors = new List<string>();

        if (string.IsNullOrWhiteSpace(scenario.Id) || !IdPattern.IsMatch(scenario.Id))
        {
            errors.Add($"scenario.id '{scenario.Id}' must match ^[a-z0-9-]+$");
        }

        if (string.IsNullOrWhiteSpace(scenario.Name))
        {
            errors.Add("scenario.name must not be empty");
        }

        if (scenario.Nodes is null || scenario.Nodes.Count == 0)
        {
            errors.Add("scenario.nodes must contain at least one node");
            return new ScenarioValidationResult(false, errors);
        }

        var nodeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in scenario.Nodes)
        {
            if (string.IsNullOrWhiteSpace(node.Id) || !IdPattern.IsMatch(node.Id))
            {
                errors.Add($"node.id '{node.Id}' must match ^[a-z0-9-]+$");
                continue;
            }
            if (!nodeIds.Add(node.Id))
            {
                errors.Add($"duplicate node.id '{node.Id}'");
            }
        }

        if (scenario.Edges is not null)
        {
            foreach (var edge in scenario.Edges)
            {
                if (!nodeIds.Contains(edge.From))
                {
                    errors.Add($"edge.from '{edge.From}' references unknown node");
                }
                if (!nodeIds.Contains(edge.To))
                {
                    errors.Add($"edge.to '{edge.To}' references unknown node");
                }
            }
        }

        if (scenario.StartNodeIds is not null)
        {
            foreach (var id in scenario.StartNodeIds)
            {
                if (!nodeIds.Contains(id))
                {
                    errors.Add($"startNodeIds entry '{id}' references unknown node");
                }
            }
        }

        if (scenario.CaseSets is not null)
        {
            foreach (var cs in scenario.CaseSets)
            {
                if (!nodeIds.Contains(cs.AnchorNodeId))
                {
                    errors.Add($"caseSet '{cs.Id}' anchorNodeId '{cs.AnchorNodeId}' references unknown node");
                }
            }
        }

        if (scenario.Groups is not null)
        {
            foreach (var g in scenario.Groups)
            {
                foreach (var nid in g.NodeIds)
                {
                    if (!nodeIds.Contains(nid))
                    {
                        errors.Add($"group '{g.Id}' nodeIds entry '{nid}' references unknown node");
                    }
                }
            }
        }

        if (scenario.Breakpoints is not null)
        {
            foreach (var bp in scenario.Breakpoints)
            {
                if (!nodeIds.Contains(bp.NodeId))
                {
                    errors.Add($"breakpoint nodeId '{bp.NodeId}' references unknown node");
                }
            }
        }

        return new ScenarioValidationResult(errors.Count == 0, errors);
    }
}
