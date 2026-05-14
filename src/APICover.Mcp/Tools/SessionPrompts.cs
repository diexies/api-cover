using System.ComponentModel;
using ModelContextProtocol.Server;

namespace APICover.Mcp.Tools;

/// <summary>
/// MCP prompts surfaced to IDE clients. Picking one in the IDE primes the LLM with
/// project-context instructions — much shorter than asking the user to type them every
/// session. Mirrors the playbook but each prompt is one-click.
/// </summary>
[McpServerPromptType]
public static class SessionPrompts
{
    [McpServerPrompt(Name = "session.start")]
    [Description("Run at the start of every chat: scans endpoints, coverage, and the service map so the LLM has a current snapshot before the user asks anything. Also restates the hard rule: method.impact before any edit.")]
    public static string SessionStart() => """
        You are connected to the APICover MCP server. APICover indexes the host's
        endpoints, service call graph, scenarios, runs, and per-method impact metadata.

        ## Step 1 — silent baseline scan
        Run in order, do NOT show raw output, summarise in <100 words for the user:
        1. mcp_apicover_endpoints_list
        2. mcp_apicover_coverage_summary
        3. mcp_apicover_service_map_summary

        ## Step 2 — keep this map of tools in working memory
        Pick the right tool by user intent. Do not invent paths or types — always
        look them up via a tool first.

        Discovery / inventory:
        - mcp_apicover_endpoints_list, mcp_apicover_endpoints_details
        - mcp_apicover_service_map_summary, mcp_apicover_service_map_top
        - mcp_apicover_service_usage, mcp_apicover_service_metrics
        - mcp_apicover_service_callers (whole service reverse fan-in)
        - mcp_apicover_endpoint_callgraph (forward tree under an endpoint)

        Impact analysis (REQUIRED before edits):
        - mcp_apicover_method_impact(type, method) — callers + callees + endpoint reach

        Coverage gaps:
        - mcp_apicover_coverage_summary, mcp_apicover_coverage_uncovered_endpoints

        Scenarios (HTTP test cases):
        - mcp_apicover_scenarios_list, scenarios_get, scenarios_save, scenarios_run, scenarios_delete

        Runs (test execution results):
        - mcp_apicover_runs_list, runs_list_failed, runs_get, runs_timeline, runs_subscribe

        Change analysis:
        - mcp_apicover_git_commit_impact

        Project memory (durable notes):
        - mcp_apicover_memory_list, memory_read, memory_write, memory_append, memory_delete

        Custom user-defined tools:
        - mcp_apicover_custom_invoke

        ## Step 3 — hard rules
        - BEFORE editing any C# method body, call mcp_apicover_method_impact(type, method).
          Read every callSite and callee. List affected endpoints in your reply.
          Then propose the smallest edit.
        - If user asks "what's broken" / "any failures" → mcp_apicover_runs_list_failed FIRST.
        - If user asks "where is X used" → mcp_apicover_service_callers or method_impact.
        - If user asks "what does endpoint X touch" → mcp_apicover_endpoint_callgraph.
        - If user asks coverage / "what should I test next" → mcp_apicover_coverage_uncovered_endpoints.
        - Never call write/delete tools (scenarios_save/delete, memory_write/delete) without confirming with the user first.
        - Never invent endpoint paths or type FQTNs — look them up.
        - Cite tool output verbatim, keep replies terse.

        After the baseline summary, ask the user what they want to do.
        """;

    [McpServerPrompt(Name = "method.edit_checklist")]
    [Description("Drop in before editing a service method — restates the impact-check rule and shows the exact tool call shape.")]
    public static string MethodEditChecklist(
        [Description("Fully-qualified declaring type, e.g. PVC.Modules.Workflow.Application.Services.WorkflowService")] string type,
        [Description("Method name, e.g. GetPendingPriceListsCountAsync")] string method) => $$"""
        Before editing {{type}}.{{method}}:

        1. Call mcp_apicover_method_impact(type="{{type}}", method="{{method}}")
        2. Read every callSites[].ref — those break first if signature/behaviour changes.
        3. Read every callees[].ref — those are the contracts you depend on.
        4. List every endpoint in directCallers in your reply.
        5. Quote the impacted refs, then propose the edit.
        """;
}
