import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const registerTools = vi.fn();
const connect = vi.fn(async () => {});
const mockServer = { connect };
const McpServer = vi.fn(function MockMcpServer() {
  return mockServer;
});
const StdioServerTransport = vi.fn(function MockStdioServerTransport() {
  return { transport: "stdio" };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport,
}));

vi.mock("../../src/mcp/tools.js", () => ({
  registerTools,
}));

const { startMcpServer } = await import("../../src/mcp/server.js");

describe("startMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates server, registers tools, and connects stdio transport", async () => {
    await startMcpServer("/tmp/project");

    expect(McpServer).toHaveBeenCalledWith({ name: "autocontext", version: "0.2.0" });
    expect(registerTools).toHaveBeenCalledWith(mockServer, "/tmp/project");
    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("logs startup message and root path on success", async () => {
    await startMcpServer("/tmp/project");

    expect(console.error).toHaveBeenCalledWith("[autocontext] MCP server started");
    expect(console.error).toHaveBeenCalledWith("[autocontext] Project root: /tmp/project");
  });

  it("propagates connection failures", async () => {
    connect.mockRejectedValueOnce(new Error("connect failed"));

    await expect(startMcpServer("/tmp/project")).rejects.toThrow("connect failed");
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("MCP server started"));
  });
});
