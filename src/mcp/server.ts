import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { SERVER_VERSION, buildCapabilityResource } from "./capabilities.js";

export async function startMcpServer(rootPath: string): Promise<void> {
  const server = new McpServer({
    name: "autocontext",
    version: SERVER_VERSION,
  });

  registerTools(server, rootPath);

  try {
    server.registerResource(
      "capabilities",
      "autocontext://capabilities",
      {
        title: "autocontext capabilities",
        description: "Server version, tools_version, and per-tool since-version metadata.",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(buildCapabilityResource(), null, 2),
          },
        ],
      }),
    );
  } catch {
    // Older SDKs without registerResource — tool-level descriptions still
    // carry the "since v0.2" marker, so degrade gracefully.
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr — stdout is the JSON-RPC channel
  console.error("[autocontext] MCP server started");
  console.error(`[autocontext] Project root: ${rootPath}`);
}
