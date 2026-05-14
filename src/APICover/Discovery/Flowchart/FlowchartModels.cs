namespace APICover.Discovery.Flowchart;

/// <summary>
/// One node in a method's control-flow flowchart. The <see cref="Type"/> drives shape
/// selection in the UI (rectangle / diamond / stadium / dashed-border catch box).
/// </summary>
public sealed record FlowchartNode(
    string Id,
    string Type,        // "start" | "end" | "process" | "decision" | "loop" | "catch" | "finally"
    string Label,       // truncated to ~80 chars for rendering
    string? FullLabel,  // null when same as Label; populated on truncation for tooltip
    int? Line,          // 1-based source line where the statement originated, for highlight cross-link
    string? Kind = null,   // process subtype: "assignment" | "return" | "throw" | "call" | null
    string? VarName = null // variable name when Kind == "assignment"
);

/// <summary>
/// Directed edge between two flowchart nodes. <see cref="Label"/> on conditional edges
/// (true/false/case value/loop/exit). <see cref="Dashed"/> set for try→catch exception arcs.
/// </summary>
public sealed record FlowchartEdge(
    string Id,
    string Source,
    string Target,
    string? Label,
    bool Dashed);

/// <summary>
/// Result envelope. <see cref="Error"/> populated when the method couldn't be located /
/// parsed. <see cref="Truncated"/> set when the node count exceeded the safety cap so the
/// UI can fall back to source-only.
/// </summary>
public sealed record FlowchartResult(
    string? MethodName,
    string Language,
    IReadOnlyList<FlowchartNode> Nodes,
    IReadOnlyList<FlowchartEdge> Edges,
    bool Truncated,
    string? Error);
