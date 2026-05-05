using System.Collections.Concurrent;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace APICover.Discovery.CallGraph;

/// <summary>
/// Resolves <c>(MethodInfo, ilOffset) → (filePath, lineNumber)</c> via the portable PDB
/// sitting next to each assembly's DLL. Best-effort: when a PDB is missing or in the legacy
/// Windows format, both outputs are <c>null</c> and the walker proceeds without source info.
/// </summary>
internal sealed class PdbResolver
{
    private readonly ConcurrentDictionary<string, MetadataReaderProvider?> _readerByAssembly = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Best-effort lookup. Returns <c>(null, null)</c> when the assembly has no
    /// portable PDB or when the IL offset doesn't fall on a known sequence point.</summary>
    public (string? FilePath, int? LineNumber) TryResolve(MethodBase method, int ilOffset)
    {
        try
        {
            var asm = method.Module.Assembly;
            if (asm.IsDynamic) return (null, null);
            var asmKey = asm.Location;
            if (string.IsNullOrEmpty(asmKey)) return (null, null);

            var provider = _readerByAssembly.GetOrAdd(asmKey, OpenPdb);
            if (provider is null) return (null, null);

            var reader = provider.GetMetadataReader();
            // Method debug-info handle: same row as the metadata token.
            var rowToken = method.MetadataToken;
            var rowId = rowToken & 0x00FFFFFF;
            var handle = MetadataTokens.MethodDebugInformationHandle(rowId);
            if (handle.IsNil) return (null, null);

            var dbg = reader.GetMethodDebugInformation(handle);
            if (dbg.SequencePointsBlob.IsNil) return (null, null);

            string? bestFile = null;
            int? bestLine = null;
            foreach (var sp in dbg.GetSequencePoints())
            {
                if (sp.IsHidden) continue;
                if (sp.Offset > ilOffset) break;
                bestFile = reader.GetString(reader.GetDocument(sp.Document).Name);
                bestLine = sp.StartLine;
            }
            return (bestFile, bestLine);
        }
        catch
        {
            return (null, null);
        }
    }

    private static MetadataReaderProvider? OpenPdb(string assemblyPath)
    {
        try
        {
            var pdbPath = Path.ChangeExtension(assemblyPath, ".pdb");
            if (!File.Exists(pdbPath)) return null;
            var bytes = File.ReadAllBytes(pdbPath);
            // Portable PDB starts with "BSJB" signature (same as managed metadata).
            if (bytes.Length < 4 || bytes[0] != 'B' || bytes[1] != 'S' || bytes[2] != 'J' || bytes[3] != 'B')
            {
                // Legacy Windows PDB — System.Reflection.Metadata can't read these.
                return null;
            }
            var stream = new MemoryStream(bytes, writable: false);
            return MetadataReaderProvider.FromPortablePdbStream(stream, MetadataStreamOptions.PrefetchMetadata);
        }
        catch
        {
            return null;
        }
    }
}
