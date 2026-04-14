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

  const withResources = server as McpServer & {
    registerResource?: McpServer["registerResource"];
  };
  if (typeof withResources.registerResource === "function") {
    withResources.registerResource(
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
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr — stdout is the JSON-RPC channel
  console.error("[autocontext] MCP server started");
  console.error(`[autocontext] Project root: ${rootPath}`);
}
