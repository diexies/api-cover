using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace APICover.Discovery.Flowchart;

/// <summary>
/// Parses a C# file with Roslyn, locates the method whose source span contains the given
/// line, then walks the syntax tree to produce a control-flow graph. Statement-per-node
/// granularity: every leaf statement gets its own process box; decisions/loops get
/// diamonds; try/catch produces a dashed exception arc; return/throw funnel into a single
/// END sink. No semantic model required — pure syntactic walk, sub-millisecond on typical
/// files.
/// </summary>
public static class MethodFlowchartBuilder
{
    public const int NodeCap = 200;

    public static FlowchartResult Build(string sourceText, int line)
    {
        if (string.IsNullOrEmpty(sourceText))
        {
            return new FlowchartResult(null, "csharp", Array.Empty<FlowchartNode>(), Array.Empty<FlowchartEdge>(), false, "empty source");
        }

        SyntaxTree tree;
        try
        {
            tree = CSharpSyntaxTree.ParseText(sourceText);
        }
        catch (Exception ex)
        {
            return new FlowchartResult(null, "csharp", Array.Empty<FlowchartNode>(), Array.Empty<FlowchartEdge>(), false, $"parse error: {ex.Message}");
        }

        var root = tree.GetRoot();
        var text = tree.GetText();
        if (line < 1 || line > text.Lines.Count)
        {
            return new FlowchartResult(null, "csharp", Array.Empty<FlowchartNode>(), Array.Empty<FlowchartEdge>(), false, $"line {line} out of range (1..{text.Lines.Count})");
        }
        var pos = text.Lines[line - 1].Start;

        // Find the innermost method/local-function whose span contains the target line.
        // Walk descendants; prefer the one closest to the line.
        SyntaxNode? methodNode = root.DescendantNodes()
            .Where(n => n is MethodDeclarationSyntax || n is LocalFunctionStatementSyntax || n is ConstructorDeclarationSyntax || n is AccessorDeclarationSyntax)
            .Where(n => n.Span.Contains(pos))
            .OrderByDescending(n => n.Span.Start)
            .FirstOrDefault();

        if (methodNode is null)
        {
            return new FlowchartResult(null, "csharp", Array.Empty<FlowchartNode>(), Array.Empty<FlowchartEdge>(), false, $"no method found at line {line}");
        }

        var methodName = MethodName(methodNode);
        var body = MethodBody(methodNode);
        if (body is null)
        {
            return new FlowchartResult(methodName, "csharp", Array.Empty<FlowchartNode>(), Array.Empty<FlowchartEdge>(), false, "method has no body (interface / abstract / extern)");
        }

        var ctx = new BuildContext(text);
        ctx.AddNode(new FlowchartNode("start", "start", methodName, null, line));
        ctx.AddNode(new FlowchartNode("end", "end", "end", null, null));
        var startExits = new List<NodeExit> { new("start", null) };

        var finalExits = ctx.Build(body, startExits);
        ctx.ConnectMany(finalExits, "end");

        return new FlowchartResult(methodName, "csharp", ctx.Nodes, ctx.Edges, ctx.Truncated, null);
    }

    private static string MethodName(SyntaxNode n) => n switch
    {
        MethodDeclarationSyntax m => m.Identifier.Text,
        LocalFunctionStatementSyntax l => l.Identifier.Text,
        ConstructorDeclarationSyntax c => c.Identifier.Text + " (ctor)",
        AccessorDeclarationSyntax a => a.Keyword.Text,
        _ => "method",
    };

    private static SyntaxNode? MethodBody(SyntaxNode n) => n switch
    {
        MethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody?.Expression,
        LocalFunctionStatementSyntax l => (SyntaxNode?)l.Body ?? l.ExpressionBody?.Expression,
        ConstructorDeclarationSyntax c => (SyntaxNode?)c.Body ?? c.ExpressionBody?.Expression,
        AccessorDeclarationSyntax a => (SyntaxNode?)a.Body ?? a.ExpressionBody?.Expression,
        _ => null,
    };

    internal readonly record struct NodeExit(string NodeId, string? Label);

    internal sealed class LoopFrame
    {
        public string LoopNodeId { get; init; } = string.Empty;
        public List<NodeExit> BreakExits { get; } = new();
    }

    internal sealed class BuildContext
    {
        private readonly List<FlowchartNode> _nodes = new();
        private readonly List<FlowchartEdge> _edges = new();
        private readonly Stack<LoopFrame> _loops = new();
        private readonly Microsoft.CodeAnalysis.Text.SourceText _text;
        private int _seq;

        public bool Truncated { get; private set; }
        public IReadOnlyList<FlowchartNode> Nodes => _nodes;
        public IReadOnlyList<FlowchartEdge> Edges => _edges;

        public BuildContext(Microsoft.CodeAnalysis.Text.SourceText text) { _text = text; }

        public string NewId() => $"n{++_seq}";

        public void AddNode(FlowchartNode n) => _nodes.Add(n);

        public string AddNode(string type, string label, int? line, string? kind = null, string? varName = null)
        {
            if (_nodes.Count >= NodeCap)
            {
                Truncated = true;
                return "end"; // funnel overflow into END
            }
            var id = NewId();
            var full = label.Length > 80 ? label : null;
            var trimmed = label.Length > 80 ? label[..77] + "..." : label;
            _nodes.Add(new FlowchartNode(id, type, trimmed, full, line, kind, varName));
            return id;
        }

        public void Connect(string source, string target, string? label = null, bool dashed = false)
        {
            if (string.IsNullOrEmpty(source) || string.IsNullOrEmpty(target)) return;
            var id = $"e{_edges.Count + 1}";
            _edges.Add(new FlowchartEdge(id, source, target, label, dashed));
        }

        public void ConnectMany(IEnumerable<NodeExit> exits, string target)
        {
            foreach (var ex in exits) Connect(ex.NodeId, target, ex.Label);
        }

        public int LineOf(SyntaxNode node)
        {
            return _text.Lines.GetLineFromPosition(node.SpanStart).LineNumber + 1;
        }

        // Recursive descent walker. Returns the open exits that fall through to the
        // next statement in source order.
        public List<NodeExit> Build(SyntaxNode node, List<NodeExit> prevExits)
        {
            if (Truncated) return prevExits;

            switch (node)
            {
                case BlockSyntax block:
                {
                    var cur = prevExits;
                    foreach (var stmt in block.Statements)
                    {
                        cur = Build(stmt, cur);
                        if (Truncated) break;
                    }
                    return cur;
                }
                case IfStatementSyntax ifs:
                    return BuildIf(ifs, prevExits);
                case SwitchStatementSyntax sw:
                    return BuildSwitch(sw, prevExits);
                case ForStatementSyntax forS:
                    return BuildLoop(forS.Condition?.ToString() ?? "for", forS.Statement, prevExits, forS);
                case ForEachStatementSyntax fe:
                    return BuildLoop($"foreach ({fe.Identifier.Text} in {fe.Expression})", fe.Statement, prevExits, fe);
                case WhileStatementSyntax ws:
                    return BuildLoop($"while {ws.Condition}", ws.Statement, prevExits, ws);
                case DoStatementSyntax doS:
                    return BuildDoWhile(doS, prevExits);
                case TryStatementSyntax tryS:
                    return BuildTry(tryS, prevExits);
                case ReturnStatementSyntax ret:
                {
                    var label = ret.Expression is null ? "" : ret.Expression.ToString();
                    var id = AddNode("process", string.IsNullOrEmpty(label) ? "return" : label, LineOf(ret), kind: "return");
                    ConnectMany(prevExits, id);
                    Connect(id, "end");
                    return new List<NodeExit>();
                }
                case ThrowStatementSyntax th:
                {
                    var (excType, msg) = ParseThrowExpression(th.Expression);
                    var bodyLabel = msg ?? (th.Expression is null ? "throw" : th.Expression.ToString());
                    var id = AddNode("process", bodyLabel, LineOf(th), kind: "throw", varName: excType);
                    ConnectMany(prevExits, id);
                    Connect(id, "end", "throw");
                    return new List<NodeExit>();
                }
                case BreakStatementSyntax br:
                {
                    if (_loops.Count == 0)
                    {
                        // Outside a loop — fall through to end as a safety net.
                        var id = AddNode("process", "break (unbound)", LineOf(br));
                        ConnectMany(prevExits, id);
                        Connect(id, "end");
                        return new List<NodeExit>();
                    }
                    // The current statement-text becomes a process node so the user sees the
                    // `break;` in the graph; its exit is collected as a break-exit on the
                    // enclosing loop instead of falling through to the next statement.
                    var bnode = AddNode("process", "break", LineOf(br));
                    ConnectMany(prevExits, bnode);
                    _loops.Peek().BreakExits.Add(new NodeExit(bnode, null));
                    return new List<NodeExit>();
                }
                case ContinueStatementSyntax co:
                {
                    if (_loops.Count == 0)
                    {
                        var id = AddNode("process", "continue (unbound)", LineOf(co));
                        ConnectMany(prevExits, id);
                        Connect(id, "end");
                        return new List<NodeExit>();
                    }
                    // Use a goto terminator so continue doesn't draw a long arc back to the loop.
                    var cnode = AddNode("process", "loop goto;", LineOf(co), kind: "loopGoto");
                    ConnectMany(prevExits, cnode);
                    return new List<NodeExit>();
                }
                case LocalDeclarationStatementSyntax loc when loc.Declaration.Variables.Count == 1 && loc.Declaration.Variables[0].Initializer is not null:
                {
                    var v = loc.Declaration.Variables[0];
                    var varName = v.Identifier.Text;
                    var init = v.Initializer!.Value;
                    if (TryEmitCoalesceThrow(init, varName, LineOf(loc), prevExits, out var coalesceExits))
                    {
                        return coalesceExits;
                    }
                    var expr = SingleLine(init.ToString());
                    var id = AddNode("process", expr, LineOf(loc), kind: "assignment", varName: varName);
                    ConnectMany(prevExits, id);
                    return new List<NodeExit> { new(id, null) };
                }
                case ExpressionStatementSyntax exprStmt when exprStmt.Expression is AssignmentExpressionSyntax asn:
                {
                    var varName = SingleLine(asn.Left.ToString());
                    if (TryEmitCoalesceThrow(asn.Right, varName, LineOf(exprStmt), prevExits, out var coalesceExits))
                    {
                        return coalesceExits;
                    }
                    var expr = SingleLine(asn.Right.ToString());
                    var id = AddNode("process", expr, LineOf(exprStmt), kind: "assignment", varName: varName);
                    ConnectMany(prevExits, id);
                    return new List<NodeExit> { new(id, null) };
                }
                default:
                {
                    // Default: any other statement becomes a process node labeled with its source text.
                    var label = SingleLine(node.ToString());
                    var id = AddNode("process", label, LineOf(node));
                    ConnectMany(prevExits, id);
                    return new List<NodeExit> { new(id, null) };
                }
            }
        }

        private List<NodeExit> BuildIf(IfStatementSyntax ifs, List<NodeExit> prevExits)
        {
            var dec = AddNode("decision", ifs.Condition.ToString(), LineOf(ifs));
            ConnectMany(prevExits, dec);
            var thenExits = Build(ifs.Statement, new List<NodeExit> { new(dec, "true") });
            List<NodeExit> elseExits;
            if (ifs.Else is not null)
            {
                elseExits = Build(ifs.Else.Statement, new List<NodeExit> { new(dec, "false") });
            }
            else
            {
                elseExits = new List<NodeExit> { new(dec, "false") };
            }
            var merged = new List<NodeExit>(thenExits.Count + elseExits.Count);
            merged.AddRange(thenExits);
            merged.AddRange(elseExits);
            return merged;
        }

        private List<NodeExit> BuildSwitch(SwitchStatementSyntax sw, List<NodeExit> prevExits)
        {
            var dec = AddNode("decision", $"switch ({sw.Expression})", LineOf(sw));
            ConnectMany(prevExits, dec);
            var allExits = new List<NodeExit>();
            foreach (var section in sw.Sections)
            {
                var labels = section.Labels.Select(l => l switch
                {
                    CaseSwitchLabelSyntax cs => cs.Value.ToString(),
                    DefaultSwitchLabelSyntax => "default",
                    CasePatternSwitchLabelSyntax cps => cps.Pattern.ToString(),
                    _ => l.ToString()
                });
                var edgeLabel = string.Join(",", labels);
                var sectionExits = new List<NodeExit> { new(dec, edgeLabel) };
                foreach (var stmt in section.Statements)
                {
                    sectionExits = Build(stmt, sectionExits);
                    if (Truncated) break;
                }
                allExits.AddRange(sectionExits);
            }
            return allExits;
        }

        private List<NodeExit> BuildLoop(string conditionLabel, SyntaxNode body, List<NodeExit> prevExits, SyntaxNode src)
        {
            var loop = AddNode("loop", conditionLabel, LineOf(src));
            ConnectMany(prevExits, loop);
            var frame = new LoopFrame { LoopNodeId = loop };
            _loops.Push(frame);
            var bodyExits = Build(body, new List<NodeExit> { new(loop, "loop") });
            _loops.Pop();
            // Instead of a long back-edge from the body's last node up to the loop diamond
            // (which sprawls across the canvas in deeply-branched bodies), emit a short
            // "loop goto" terminator under each body exit. Visually anchors the iteration
            // intent next to the statement that triggers it.
            foreach (var ex in bodyExits)
            {
                var gotoId = AddNode("process", "loop goto;", null, kind: "loopGoto");
                Connect(ex.NodeId, gotoId, ex.Label);
            }
            var exits = new List<NodeExit> { new(loop, "exit") };
            exits.AddRange(frame.BreakExits);
            return exits;
        }

        private List<NodeExit> BuildDoWhile(DoStatementSyntax doS, List<NodeExit> prevExits)
        {
            // Body executes first, then the loop diamond checks the condition.
            var loop = AddNode("loop", $"do/while {doS.Condition}", LineOf(doS));
            var frame = new LoopFrame { LoopNodeId = loop };
            _loops.Push(frame);
            var bodyExits = Build(doS.Statement, prevExits);
            _loops.Pop();
            foreach (var ex in bodyExits) Connect(ex.NodeId, loop, ex.Label);
            // Self loopback replaced with a goto terminator off the diamond's loop edge.
            var gotoId = AddNode("process", "loop goto;", null, kind: "loopGoto");
            Connect(loop, gotoId, "loop");
            var exits = new List<NodeExit> { new(loop, "exit") };
            exits.AddRange(frame.BreakExits);
            return exits;
        }

        private List<NodeExit> BuildTry(TryStatementSyntax tryS, List<NodeExit> prevExits)
        {
            // Try block: regular sequential build.
            var tryExits = Build(tryS.Block, prevExits);

            // Single catch sink shared by all catch clauses. Dashed edge from try-block
            // anchor to the catch node so the user sees "anything in here can throw".
            var allExits = new List<NodeExit>(tryExits);
            if (tryS.Catches.Count > 0)
            {
                // Anchor for the dashed edge: connect from the *first* node in the try block.
                // We approximate by using each tryExits-source — for typical short try blocks
                // these collapse to one anchor. Cleaner: dashed edge from the last process
                // node into catch. Pick the *first* try statement's node by re-scanning if
                // tryS.Block.Statements is non-empty.
                string anchor = tryExits.FirstOrDefault().NodeId ?? "";
                foreach (var catchClause in tryS.Catches)
                {
                    var typeLabel = catchClause.Declaration?.Type?.ToString() ?? "Exception";
                    var catchNode = AddNode("catch", $"catch {typeLabel}", LineOf(catchClause));
                    if (!string.IsNullOrEmpty(anchor)) Connect(anchor, catchNode, null, dashed: true);
                    var catchExits = Build(catchClause.Block, new List<NodeExit> { new(catchNode, null) });
                    allExits.AddRange(catchExits);
                }
            }

            if (tryS.Finally is not null)
            {
                var fin = AddNode("finally", "finally", LineOf(tryS.Finally));
                foreach (var ex in allExits) Connect(ex.NodeId, fin, ex.Label);
                var finExits = Build(tryS.Finally.Block, new List<NodeExit> { new(fin, null) });
                return finExits;
            }
            return allExits;
        }

        /// <summary>
        /// Detect the `x ?? throw E` pattern (null-coalescing with a throw expression on the right).
        /// Renders it as a condition diamond — "is `x` null?" — with the assignment on the
        /// false branch and the throw on the true branch, mirroring how the user reads the code.
        /// Returns true when the pattern was recognised and emitted; in that case the caller
        /// must NOT also emit a plain assignment node.
        /// </summary>
        private bool TryEmitCoalesceThrow(ExpressionSyntax init, string varName, int line, List<NodeExit> prevExits, out List<NodeExit> exits)
        {
            exits = new List<NodeExit>();
            if (init is not BinaryExpressionSyntax bin) return false;
            if (!bin.IsKind(SyntaxKind.CoalesceExpression)) return false;
            if (bin.Right is not ThrowExpressionSyntax throwExpr) return false;

            var leftText = SingleLine(bin.Left.ToString());
            var decisionId = AddNode("decision", $"{leftText} == null", line);
            ConnectMany(prevExits, decisionId);

            // true branch: throw → end
            var (excType, msg) = ParseThrowExpression(throwExpr.Expression);
            var throwBody = msg ?? SingleLine(throwExpr.Expression.ToString());
            var throwNode = AddNode("process", throwBody, line, kind: "throw", varName: excType);
            Connect(decisionId, throwNode, "true");
            Connect(throwNode, "end", "throw");

            // false branch: assign varName = bin.Left
            var assignNode = AddNode("process", leftText, line, kind: "assignment", varName: varName);
            Connect(decisionId, assignNode, "false");
            exits.Add(new NodeExit(assignNode, null));
            return true;
        }

        /// <summary>
        /// Pull a `(ExceptionType, "message")` pair out of `new ExceptionType("msg", …)`.
        /// Returns nulls when the expression doesn't match an object-creation form (e.g.
        /// `throw _factory.Make()` or `throw _cachedEx`).
        /// </summary>
        private static (string? Type, string? Message) ParseThrowExpression(ExpressionSyntax? expr)
        {
            if (expr is null) return (null, null);
            // `throw new X(args...)` → ObjectCreationExpressionSyntax.
            ObjectCreationExpressionSyntax? obj = expr as ObjectCreationExpressionSyntax;
            if (obj is null) return (null, null);
            var typeName = obj.Type switch
            {
                QualifiedNameSyntax q => q.Right.Identifier.Text,
                SimpleNameSyntax s => s.Identifier.Text,
                _ => obj.Type.ToString()
            };
            string? msg = null;
            if (obj.ArgumentList is not null && obj.ArgumentList.Arguments.Count > 0)
            {
                var first = obj.ArgumentList.Arguments[0].Expression;
                msg = first switch
                {
                    LiteralExpressionSyntax lit => lit.Token.ValueText,         // unquoted string
                    InterpolatedStringExpressionSyntax interp => interp.ToString(),
                    _ => first.ToString()
                };
            }
            return (typeName, msg);
        }

        private static string SingleLine(string s)
        {
            var trimmed = s.Trim().Replace("\r", " ").Replace("\n", " ");
            while (trimmed.Contains("  ")) trimmed = trimmed.Replace("  ", " ");
            return trimmed;
        }
    }
}
