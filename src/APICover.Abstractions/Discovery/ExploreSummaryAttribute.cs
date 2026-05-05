namespace APICover.Abstractions.Discovery;

/// <summary>
/// Attach a human-readable description to an interface, method, or class. The call-graph
/// walker surfaces this in the inspector's "internals" tab so a vibe-coded backend dev
/// can see WHY a method exists, not just its name.
/// <para/>
/// Apply to interface methods to document service contracts:
/// <code>
/// public interface IUserService
/// {
///     [ExploreSummary("Validates user credentials and returns the JWT.")]
///     Task&lt;string&gt; LoginAsync(string email, string password);
/// }
/// </code>
/// <para/>
/// When applied to an interface declaration, the summary describes the service as a whole
/// and shows on every method node.
/// </summary>
[AttributeUsage(AttributeTargets.Interface | AttributeTargets.Method | AttributeTargets.Class, Inherited = false, AllowMultiple = false)]
public sealed class ExploreSummaryAttribute : Attribute
{
    public ExploreSummaryAttribute(string summary)
    {
        Summary = summary ?? string.Empty;
    }

    /// <summary>Free-form description. Plain text; the UI renders it as-is below the call name.</summary>
    public string Summary { get; }
}
