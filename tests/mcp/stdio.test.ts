import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeContext } from "../../src/core/writer.js";
import { cleanupTmpDir, createTmpDir, makeLeanContext } from "../helpers.js";

const DIST_CLI = resolve(process.cwd(), "dist/index.js");
const itWithBuiltCli = existsSync(DIST_CLI) ? it : it.skip;

describe("MCP stdio smoke", () => {
  let transport: StdioClientTransport | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (transport) {
      await transport.close();
      transport = null;
    }
    if (tmpDir) {
      await cleanupTmpDir(tmpDir);
      tmpDir = null;
    }
  });

  itWithBuiltCli("serves legacy tools through the SDK transport and exposes capabilities", async () => {
    tmpDir = await createTmpDir();
    await writeContext(tmpDir, makeLeanContext({
      scope: ".",
      summary: "Smoke-test project root",
    }));

    const client = new Client({
      name: "autocontext-stdio-smoke",
      version: "1.0.0",
    });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "serve", "--path", tmpDir],
      cwd: process.cwd(),
      stderr: "pipe",
    });

    await client.connect(transport);

    const query = await client.callTool({
      name: "query_context",
      arguments: { scope: "." },
    });
    const queryBody = query.content.find((item) => item.type === "text");
    expect(queryBody && "text" in queryBody ? JSON.parse(queryBody.text) : null).toMatchObject({
      found: true,
      scope: ".",
      context: expect.objectContaining({
        summary: "Smoke-test project root",
      }),
    });

    const resource = await client.readResource({ uri: "autocontext://capabilities" });
    const resourceBody = resource.contents.find((item) => "text" in item);
    expect(resourceBody && "text" in resourceBody ? JSON.parse(resourceBody.text) : null).toMatchObject({
      server_version: "0.2.0",
      tools_version: 2,
      compat: expect.objectContaining({
        legacy_state_tools: expect.arrayContaining(["check_freshness", "list_contexts"]),
      }),
    });
  });
});
