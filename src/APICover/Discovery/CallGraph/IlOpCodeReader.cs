using System.Reflection.Emit;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// IL opcode decoder. Iterates a method's IL byte array and surfaces every
/// <c>call</c> / <c>callvirt</c> / <c>newobj</c> instruction with its 4-byte metadata token
/// operand. All other opcodes are skipped according to their declared operand size; the
/// canonical opcode-length table is reflected from <see cref="OpCodes"/> at first use so
/// it always matches what the BCL says.
/// </summary>
internal static class IlOpCodeReader
{
    /// <summary>One emitted call site found during the walk.</summary>
    public readonly record struct CallSite(int IlOffset, OpCode Op, int MetadataToken);

    private static readonly Dictionary<short, OpCode> OneByteOps;
    private static readonly Dictionary<short, OpCode> TwoByteOps;

    static IlOpCodeReader()
    {
        OneByteOps = new Dictionary<short, OpCode>();
        TwoByteOps = new Dictionary<short, OpCode>();
        foreach (var field in typeof(OpCodes).GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
        {
            if (field.FieldType != typeof(OpCode)) continue;
            var op = (OpCode)field.GetValue(null)!;
            var v = op.Value;
            if (v < 0x100 && v >= -0x100)
            {
                OneByteOps[(short)v] = op;
            }
            else
            {
                // Two-byte opcodes start with 0xFE; the second byte is the high nibble shifted in.
                TwoByteOps[(short)(v & 0xFF)] = op;
            }
        }
    }

    /// <summary>Decode <paramref name="il"/>, yield each call/callvirt/newobj.</summary>
    public static IEnumerable<CallSite> EnumerateCalls(byte[] il)
    {
        var i = 0;
        while (i < il.Length)
        {
            var startOffset = i;
            OpCode op;
            byte b1 = il[i++];
            if (b1 == 0xFE)
            {
                if (i >= il.Length) yield break;
                byte b2 = il[i++];
                if (!TwoByteOps.TryGetValue(b2, out op))
                {
                    // Unknown two-byte opcode — bail; the rest of the stream cannot be reliably parsed.
                    yield break;
                }
            }
            else
            {
                if (!OneByteOps.TryGetValue(b1, out op))
                {
                    yield break;
                }
            }

            var operandType = op.OperandType;
            switch (operandType)
            {
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineTok:
                {
                    if (i + 4 > il.Length) yield break;
                    var token = BitConverter.ToInt32(il, i);
                    i += 4;
                    if (op == OpCodes.Call || op == OpCodes.Callvirt || op == OpCodes.Newobj)
                    {
                        yield return new CallSite(startOffset, op, token);
                    }
                    break;
                }
                case OperandType.InlineNone:
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    i += 1;
                    break;
                case OperandType.InlineVar:
                    i += 2;
                    break;
                case OperandType.InlineBrTarget:
                case OperandType.InlineField:
                case OperandType.InlineI:
                case OperandType.InlineString:
                case OperandType.InlineType:
                case OperandType.ShortInlineR:
                    i += 4;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    i += 8;
                    break;
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > il.Length) yield break;
                    var n = BitConverter.ToInt32(il, i);
                    i += 4 + 4 * n;
                    break;
                }
                default:
                    // Unknown operand type — bail to avoid skipping the wrong number of bytes.
                    yield break;
            }
        }
    }

    /// <summary>One IL instruction surfaced to the signal scanner.</summary>
    public readonly record struct AnyInstruction(int IlOffset, OpCode Op, int? Token, string? StringLiteral);

    /// <summary>Decode every IL instruction in <paramref name="il"/> in order. Used by
    /// <see cref="IlWalker"/> to scan for `throw`, conditional branches, and `ldstr`-after-call
    /// patterns that hint at intent (log messages, validation messages).</summary>
    public static IEnumerable<AnyInstruction> EnumerateAll(byte[] il, System.Reflection.Module module)
    {
        var i = 0;
        while (i < il.Length)
        {
            var startOffset = i;
            OpCode op;
            byte b1 = il[i++];
            if (b1 == 0xFE)
            {
                if (i >= il.Length) yield break;
                byte b2 = il[i++];
                if (!TwoByteOps.TryGetValue(b2, out op)) yield break;
            }
            else
            {
                if (!OneByteOps.TryGetValue(b1, out op)) yield break;
            }

            int? token = null;
            string? str = null;
            var operandType = op.OperandType;
            switch (operandType)
            {
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineTok:
                case OperandType.InlineField:
                case OperandType.InlineType:
                {
                    if (i + 4 > il.Length) yield break;
                    token = BitConverter.ToInt32(il, i);
                    i += 4;
                    break;
                }
                case OperandType.InlineString:
                {
                    if (i + 4 > il.Length) yield break;
                    var t = BitConverter.ToInt32(il, i);
                    i += 4;
                    if (op == OpCodes.Ldstr)
                    {
                        try { str = module.ResolveString(t); } catch { /* best-effort */ }
                    }
                    break;
                }
                case OperandType.InlineBrTarget:
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                    i += 4;
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    i += 1;
                    break;
                case OperandType.InlineVar:
                    i += 2;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    i += 8;
                    break;
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > il.Length) yield break;
                    var n = BitConverter.ToInt32(il, i);
                    i += 4 + 4 * n;
                    break;
                }
                case OperandType.InlineNone:
                    break;
                default:
                    yield break;
            }
            yield return new AnyInstruction(startOffset, op, token, str);
        }
    }

    /// <summary>Best-effort: find the metadata token of the most recent <c>newobj</c> emitted
    /// before <paramref name="beforeOffset"/>. Used to recover the concrete request type at a
    /// <c>ISender.Send(new XCommand(...))</c> call site so the walker can resolve the matching
    /// <c>IRequestHandler&lt;TRequest,TResponse&gt;.Handle</c> body. Returns <c>null</c> if no
    /// usable <c>newobj</c> precedes the call.</summary>
    public static int? FindLastNewobjTokenBefore(byte[] il, int beforeOffset)
    {
        int? last = null;
        var i = 0;
        while (i < beforeOffset && i < il.Length)
        {
            var startOffset = i;
            OpCode op;
            byte b1 = il[i++];
            if (b1 == 0xFE)
            {
                if (i >= il.Length) break;
                byte b2 = il[i++];
                if (!TwoByteOps.TryGetValue(b2, out op)) break;
            }
            else
            {
                if (!OneByteOps.TryGetValue(b1, out op)) break;
            }

            var operandType = op.OperandType;
            switch (operandType)
            {
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineTok:
                {
                    if (i + 4 > il.Length) return last;
                    var token = BitConverter.ToInt32(il, i);
                    i += 4;
                    if (op == OpCodes.Newobj) last = token;
                    break;
                }
                case OperandType.InlineString:
                case OperandType.InlineBrTarget:
                case OperandType.InlineField:
                case OperandType.InlineI:
                case OperandType.InlineType:
                case OperandType.ShortInlineR:
                    i += 4;
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    i += 1;
                    break;
                case OperandType.InlineVar:
                    i += 2;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    i += 8;
                    break;
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > il.Length) return last;
                    var n = BitConverter.ToInt32(il, i);
                    i += 4 + 4 * n;
                    break;
                }
                case OperandType.InlineNone:
                    break;
                default:
                    return last;
            }
            if (i == startOffset) break; // safety
        }
        return last;
    }

    /// <summary>Best-effort: find the most recent <c>ldstr</c> immediately before a given IL
    /// offset so external-HTTP boundaries can surface the URL. Returns <c>null</c> if no
    /// usable <c>ldstr</c> precedes the call.</summary>
    public static string? FindLastLdstrBefore(byte[] il, int beforeOffset, System.Reflection.Module module)
    {
        string? last = null;
        var i = 0;
        while (i < beforeOffset && i < il.Length)
        {
            var startOffset = i;
            OpCode op;
            byte b1 = il[i++];
            if (b1 == 0xFE)
            {
                if (i >= il.Length) break;
                byte b2 = il[i++];
                if (!TwoByteOps.TryGetValue(b2, out op)) break;
            }
            else
            {
                if (!OneByteOps.TryGetValue(b1, out op)) break;
            }

            var operandType = op.OperandType;
            switch (operandType)
            {
                case OperandType.InlineString:
                {
                    if (i + 4 > il.Length) return last;
                    var token = BitConverter.ToInt32(il, i);
                    i += 4;
                    if (op == OpCodes.Ldstr)
                    {
                        try { last = module.ResolveString(token); } catch { /* best-effort */ }
                    }
                    break;
                }
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineTok:
                case OperandType.InlineBrTarget:
                case OperandType.InlineField:
                case OperandType.InlineI:
                case OperandType.InlineType:
                case OperandType.ShortInlineR:
                    i += 4;
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    i += 1;
                    break;
                case OperandType.InlineVar:
                    i += 2;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    i += 8;
                    break;
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > il.Length) return last;
                    var n = BitConverter.ToInt32(il, i);
                    i += 4 + 4 * n;
                    break;
                }
                case OperandType.InlineNone:
                    break;
                default:
                    return last;
            }
            if (i == startOffset) break; // safety
        }
        return last;
    }
}
