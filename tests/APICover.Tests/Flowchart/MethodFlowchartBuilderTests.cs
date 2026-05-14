using APICover.Discovery.Flowchart;

namespace APICover.Tests.Flowchart;

public class MethodFlowchartBuilderTests
{
    private static FlowchartResult Build(string body, string method = "Sample")
    {
        // Multi-line layout so the caret on line 3 sits inside the method body span.
        var src = $"public class C {{\n  public void {method}() {{\n    {body}\n  }}\n}}";
        return MethodFlowchartBuilder.Build(src, 3);
    }

    [Fact]
    public void LinearMethodProducesProcessChain()
    {
        var r = Build("var x = 1; var y = 2; var z = x + y;");
        Assert.Null(r.Error);
        Assert.Contains(r.Nodes, n => n.Type == "start");
        Assert.Contains(r.Nodes, n => n.Type == "end");
        Assert.Equal(3, r.Nodes.Count(n => n.Type == "process"));
    }

    [Fact]
    public void IfStatementEmitsDecision()
    {
        var r = Build("if (x > 0) { var y = 1; } else { var y = 2; }");
        Assert.Null(r.Error);
        var decision = Assert.Single(r.Nodes, n => n.Type == "decision");
        Assert.Contains(r.Edges, e => e.Source == decision.Id && e.Label == "true");
        Assert.Contains(r.Edges, e => e.Source == decision.Id && e.Label == "false");
    }

    [Fact]
    public void IfWithoutElseFallsThrough()
    {
        var r = Build("if (ok) { var y = 1; }");
        Assert.Null(r.Error);
        var decision = Assert.Single(r.Nodes, n => n.Type == "decision");
        // Decision's "false" exit must reach the end (no else branch present).
        Assert.Contains(r.Edges, e => e.Source == decision.Id && e.Label == "false" && e.Target == "end");
    }

    [Fact]
    public void ForLoopHasGotoTerminator()
    {
        var r = Build("for (var i = 0; i < 10; i++) { Use(i); }");
        Assert.Null(r.Error);
        var loop = Assert.Single(r.Nodes, n => n.Type == "loop");
        // Body exit edges into a "loop goto" terminator node — no long back-edge to the loop diamond.
        Assert.Contains(r.Nodes, n => n.Kind == "loopGoto");
        Assert.Contains(r.Edges, e => e.Source == loop.Id && e.Label == "exit");
    }

    [Fact]
    public void SwitchEmitsLabeledBranches()
    {
        var r = Build("switch (x) { case 1: Do1(); break; case 2: Do2(); break; default: Do0(); break; }");
        Assert.Null(r.Error);
        var decision = Assert.Single(r.Nodes, n => n.Type == "decision");
        var outEdges = r.Edges.Where(e => e.Source == decision.Id).ToList();
        Assert.Equal(3, outEdges.Count);
        Assert.Contains(outEdges, e => e.Label == "1");
        Assert.Contains(outEdges, e => e.Label == "2");
        Assert.Contains(outEdges, e => e.Label == "default");
    }

    [Fact]
    public void TryCatchEmitsDashedEdge()
    {
        var r = Build("try { Do(); } catch (System.Exception) { Log(); }");
        Assert.Null(r.Error);
        Assert.Contains(r.Nodes, n => n.Type == "catch");
        Assert.Contains(r.Edges, e => e.Dashed);
    }

    [Fact]
    public void TryCatchFinallyEmitsFinallyJoin()
    {
        var r = Build("try { Do(); } catch { Log(); } finally { Cleanup(); }");
        Assert.Null(r.Error);
        Assert.Contains(r.Nodes, n => n.Type == "finally");
    }

    [Fact]
    public void EarlyReturnDirectlyToEnd()
    {
        var r = Build("if (x) return; var y = 1;");
        Assert.Null(r.Error);
        // The return node's edge goes to "end".
        var returnNode = r.Nodes.First(n => n.Type == "process" && n.Label.StartsWith("return"));
        Assert.Contains(r.Edges, e => e.Source == returnNode.Id && e.Target == "end");
    }

    [Fact]
    public void BreakExitsLoop()
    {
        var r = Build("for (var i = 0; i < 10; i++) { if (i == 5) break; Use(i); }");
        Assert.Null(r.Error);
        var loop = Assert.Single(r.Nodes, n => n.Type == "loop");
        var breakNode = r.Nodes.First(n => n.Type == "process" && n.Label == "break");
        // Break should NOT loop back; instead its exit folds into the loop's exit set →
        // it should ultimately reach end (or whatever follows the loop).
        Assert.Contains(r.Edges, e => e.Source == breakNode.Id);
        // The loop node should still have an "exit" edge of its own.
        Assert.Contains(r.Edges, e => e.Source == loop.Id && e.Label == "exit");
    }

    [Fact]
    public void ContinueEmitsGotoTerminator()
    {
        var r = Build("for (var i = 0; i < 10; i++) { if (i % 2 == 0) continue; Use(i); }");
        Assert.Null(r.Error);
        Assert.Single(r.Nodes, n => n.Type == "loop");
        // continue surfaces as a loopGoto-kind terminator instead of a back-edge.
        var gotos = r.Nodes.Where(n => n.Kind == "loopGoto").ToList();
        Assert.NotEmpty(gotos);
    }

    [Fact]
    public void NullCoalesceThrowEmitsDecision()
    {
        var r = Build("var id = user?.Id ?? throw new System.Exception(\"x\"); Use(id);");
        Assert.Null(r.Error);
        var decision = Assert.Single(r.Nodes, n => n.Type == "decision" && n.Label.Contains("== null"));
        // true branch points at the throw node which routes to end.
        Assert.Contains(r.Edges, e => e.Source == decision.Id && e.Label == "true");
        // false branch points at the assignment carrying varName "id".
        Assert.Contains(r.Nodes, n => n.Kind == "assignment" && n.VarName == "id");
    }

    [Fact]
    public void EmptySourceReturnsError()
    {
        var r = MethodFlowchartBuilder.Build("", 1);
        Assert.NotNull(r.Error);
    }

    [Fact]
    public void LineOutOfRangeReturnsError()
    {
        var r = MethodFlowchartBuilder.Build("public class C {}", 999);
        Assert.NotNull(r.Error);
    }
}
