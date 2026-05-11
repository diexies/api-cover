using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;

// Stdio host for the APICover MCP server. Boots the inspector services + MCP tools
// in the current working directory so an IDE can attach via the standard
// `mcpServers` config and let its LLM call APICover tools without needing a
// running web app.

var builder = Host.CreateApplicationBuilder(args);

// Diagnostics on stderr only — stdio transport reserves stdout for JSON-RPC.
builder.Logging.ClearProviders();

// MCP transport: stdio. Tools auto-discovered from the APICover.Mcp assembly.
builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly(typeof(APICover.Mcp.Tools.EndpointsTools).Assembly);

await builder.Build().RunAsync();
