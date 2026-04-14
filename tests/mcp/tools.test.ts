import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import {
  handleQueryContext,
  handleCheckFreshness,
  handleListContexts,
  handleAggregateEvidence,
  registerTools,
} from "../../src/mcp/tools.js";
import { writeContext } from "../../src/core/writer.js";
import { computeFingerprint } from "../../src/core/fingerprint.js";
import { CONTEXT_FILENAME } from "../../src/core/schema.js";
import { saveConfig } from "../../src/utils/config.js";
import {
  createTmpDir,
  cleanupTmpDir,
  createFile,
  createNestedFile,
  makeValidContext,
} from "../helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

// --- handleQueryContext ---

describe("handleQueryContext", () => {
  it("returns full context when no filter is provided", async () => {
    await createFile(tmpDir, "index.ts", "export const x = 1;");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp, summary: "Core module" }));

    const result = await handleQueryContext({ scope: "." }, tmpDir);
    expect(result.found).toBe(true);
    expect(result.context).toBeDefined();
    expect(result.context!.summary).toBe("Core module");
    expect(result.context!.files).toBeDefined();
    expect(result.context!.maintenance).toBeDefined();
  });

  it("returns filtered fields plus metadata when filter is provided", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      summary: "Test",
      interfaces: [{ name: "foo()", description: "Does foo" }],
    }));

    const result = await handleQueryContext(
      { scope: ".", filter: ["summary", "interfaces"] },
      tmpDir,
    );
    expect(result.found).toBe(true);
    expect(result.context!.summary).toBe("Test");
    expect(result.context!.interfaces).toHaveLength(1);
    // Metadata always present
    expect(result.context!.version).toBe(1);
    expect(result.context!.scope).toBeDefined();
    expect(result.context!.fingerprint).toBeDefined();
    expect(result.context!.last_updated).toBeDefined();
    // Fields not in filter are absent
    expect(result.context!.files).toBeUndefined();
    expect(result.context!.maintenance).toBeUndefined();
  });

  it("returns found=false when no .context.yaml exists", async () => {
    await createFile(tmpDir, "index.ts", "code");

    const result = await handleQueryContext({ scope: "." }, tmpDir);
    expect(result.found).toBe(false);
    expect(result.error).toContain("No .context.yaml");
  });

  it("returns error for invalid/corrupt .context.yaml", async () => {
    // Write a file that exists but is not valid context YAML
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "not: valid\ncontext: file\n");

    const result = await handleQueryContext({ scope: "." }, tmpDir);
    expect(result.found).toBe(false);
    expect(result.error).toContain("Invalid or corrupt");
  });

  it("resolves subdirectory scopes correctly", async () => {
    const subDir = join(tmpDir, "src", "core");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "schema.ts", "export const x = 1;");
    const fp = await computeFingerprint(subDir);
    await writeContext(subDir, makeValidContext({
      scope: "src/core",
      fingerprint: fp,
      summary: "Schema definitions",
    }));

    const result = await handleQueryContext({ scope: "src/core" }, tmpDir);
    expect(result.found).toBe(true);
    expect(result.context!.summary).toBe("Schema definitions");
  });

  it("accepts backslash-separated scopes (Windows-style)", async () => {
    const subDir = join(tmpDir, "src", "core");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "schema.ts", "export const x = 1;");
    const fp = await computeFingerprint(subDir);
    await writeContext(subDir, makeValidContext({
      scope: "src/core",
      fingerprint: fp,
      summary: "Schema definitions",
    }));

    const result = await handleQueryContext({ scope: "src\\core" }, tmpDir);
    expect(result.found).toBe(true);
    expect(result.context!.summary).toBe("Schema definitions");
  });

  it("ignores invalid filter values", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    const result = await handleQueryContext(
      { scope: ".", filter: ["summary", "nonexistent_field"] },
      tmpDir,
    );
    expect(result.found).toBe(true);
    expect(result.context!.summary).toBeDefined();
    expect(result.context!["nonexistent_field"]).toBeUndefined();
  });

  it("rejects path traversal", async () => {
    const result = await handleQueryContext({ scope: "../../etc" }, tmpDir);
    expect(result.found).toBe(false);
    expect(result.error).toContain("path traversal");
  });

  it("rejects backslash path traversal", async () => {
    const result = await handleQueryContext({ scope: "..\\..\\etc" }, tmpDir);
    expect(result.found).toBe(false);
    expect(result.error).toContain("path traversal");
  });

  it("returns error for unsupported schema version (soft-fail)", async () => {
    const v2Context = { ...makeValidContext(), version: 2 };
    await writeFile(join(tmpDir, CONTEXT_FILENAME), stringify(v2Context));

    const result = await handleQueryContext({ scope: "." }, tmpDir);
    expect(result.found).toBe(false);
    expect(result.error).toContain("Unsupported schema version");
    expect(result.error).toContain("2");
  });

  it("uses path override instead of defaultRoot", async () => {
    const altRoot = await createTmpDir();
    try {
      await createFile(altRoot, "index.ts", "code");
      const fp = await computeFingerprint(altRoot);
      await writeContext(altRoot, makeValidContext({ fingerprint: fp, summary: "Alt root" }));

      // defaultRoot has no context, but path override points to altRoot
      const result = await handleQueryContext({ scope: ".", path: altRoot }, tmpDir);
      expect(result.found).toBe(true);
      expect(result.context!.summary).toBe("Alt root");
    } finally {
      await cleanupTmpDir(altRoot);
    }
  });
});

// --- handleCheckFreshness ---

describe("handleCheckFreshness", () => {
  it("returns fresh when fingerprint matches", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.state).toBe("fresh");
    expect(result.fingerprint!.stored).toBe(fp);
    expect(result.fingerprint!.computed).toBe(fp);
  });

  it("returns stale when files have changed", async () => {
    await createFile(tmpDir, "index.ts", "short");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    // Write content of different length to guarantee different fingerprint
    await createFile(tmpDir, "index.ts", "this is much longer content that changes the size");

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.state).toBe("stale");
    expect(result.fingerprint!.stored).toBe(fp);
    expect(result.fingerprint!.computed).not.toBe(fp);
  });

  it("returns missing when no .context.yaml exists", async () => {
    await createFile(tmpDir, "index.ts", "code");

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("No .context.yaml");
  });

  it("includes last_updated in result", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      last_updated: "2026-01-15T10:00:00.000Z",
    }));

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.last_updated).toBe("2026-01-15T10:00:00.000Z");
  });

  it("accepts backslash-separated scopes for freshness checks", async () => {
    const subDir = join(tmpDir, "src", "core");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "schema.ts", "export const x = 1;");
    const fp = await computeFingerprint(subDir);
    await writeContext(subDir, makeValidContext({
      scope: "src/core",
      fingerprint: fp,
      summary: "Schema definitions",
    }));

    const result = await handleCheckFreshness({ scope: "src\\core" }, tmpDir);
    expect(result.state).toBe("fresh");
    expect(result.fingerprint?.stored).toBe(fp);
  });

  it("returns error for unsupported schema version (soft-fail)", async () => {
    const v2Context = { ...makeValidContext(), version: 2 };
    await writeFile(join(tmpDir, CONTEXT_FILENAME), stringify(v2Context));

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("Unsupported schema version");
    expect(result.error).toContain("2");
  });

  it("returns error for invalid/corrupt .context.yaml", async () => {
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "not: valid\ncontext: file\n");

    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("Invalid or corrupt");
  });

  it("rejects path traversal", async () => {
    const result = await handleCheckFreshness({ scope: "../../etc" }, tmpDir);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("path traversal");
  });

  it("rejects backslash path traversal", async () => {
    const result = await handleCheckFreshness({ scope: "..\\..\\etc" }, tmpDir);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("path traversal");
  });

  it("uses path override instead of defaultRoot", async () => {
    const altRoot = await createTmpDir();
    try {
      await createFile(altRoot, "index.ts", "code");
      const fp = await computeFingerprint(altRoot);
      await writeContext(altRoot, makeValidContext({ fingerprint: fp }));

      const result = await handleCheckFreshness({ scope: ".", path: altRoot }, tmpDir);
      expect(result.state).toBe("fresh");
      expect(result.fingerprint!.stored).toBe(fp);
    } finally {
      await cleanupTmpDir(altRoot);
    }
  });
});

// --- handleListContexts ---

describe("handleListContexts", () => {
  beforeEach(async () => {
    // Disable token threshold for tests (tiny fixture files would be filtered out)
    await saveConfig(tmpDir, { provider: "anthropic", min_tokens: 0 });
  });

  it("lists tracked directories with fresh status", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp, summary: "Root" }));

    const result = await handleListContexts({}, tmpDir);
    expect(result.tracked).toBe(1);
    const root = result.entries.find((e) => e.scope === ".");
    expect(root).toBeDefined();
    expect(root!.state).toBe("fresh");
    expect(root!.summary).toBe("Root");
  });

  it("lists untracked directories as missing", async () => {
    await createFile(tmpDir, "index.ts", "code");

    const result = await handleListContexts({}, tmpDir);
    const root = result.entries.find((e) => e.scope === ".");
    expect(root).toBeDefined();
    expect(root!.has_context).toBe(false);
    expect(root!.state).toBe("missing");
  });

  it("handles nested directories", async () => {
    // Root
    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: rootFp, scope: "." }));

    // Subdirectory
    const subDir = join(tmpDir, "src");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "app.ts", "app code");
    const subFp = await computeFingerprint(subDir);
    await writeContext(subDir, makeValidContext({
      fingerprint: subFp,
      scope: "src",
      summary: "App source",
    }));

    const result = await handleListContexts({}, tmpDir);
    expect(result.total_directories).toBe(2);
    expect(result.tracked).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it("reports stale directories", async () => {
    await createFile(tmpDir, "index.ts", "short");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    // Change file size to force staleness
    await createFile(tmpDir, "index.ts", "this is much longer content that changes the size");

    const result = await handleListContexts({}, tmpDir);
    const root = result.entries.find((e) => e.scope === ".");
    expect(root!.state).toBe("stale");
  });

  it("entries are sorted by scope", async () => {
    // Create multiple directories
    await createFile(tmpDir, "index.ts", "root");

    const srcDir = join(tmpDir, "src");
    await mkdir(srcDir, { recursive: true });
    await createFile(srcDir, "app.ts", "code");

    const libDir = join(tmpDir, "lib");
    await mkdir(libDir, { recursive: true });
    await createFile(libDir, "util.ts", "code");

    const result = await handleListContexts({}, tmpDir);
    const scopes = result.entries.map((e) => e.scope);

    // Should be lexicographically sorted
    const sorted = [...scopes].sort();
    expect(scopes).toEqual(sorted);
  });

  it("skips unsupported-version directories without crashing (mixed repo)", async () => {
    // Root: valid context
    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: rootFp, scope: ".", summary: "Root" }));

    // Subdirectory: unsupported version 2 context
    const subDir = join(tmpDir, "src");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "app.ts", "app code");
    const v2Context = { ...makeValidContext({ scope: "src" }), version: 2 };
    await writeFile(join(subDir, CONTEXT_FILENAME), stringify(v2Context));

    const result = await handleListContexts({}, tmpDir);
    expect(result.total_directories).toBe(2);
    // Only the valid root is tracked; v2 dir is treated as missing
    expect(result.tracked).toBe(1);
    expect(result.entries).toHaveLength(2);

    const rootEntry = result.entries.find((e) => e.scope === ".");
    expect(rootEntry!.has_context).toBe(true);
    expect(rootEntry!.summary).toBe("Root");

    const srcEntry = result.entries.find((e) => e.scope === "src");
    expect(srcEntry!.has_context).toBe(false);
    expect(srcEntry!.state).toBe("missing");
  });

  it("returns error structure for non-existent root (global failure)", async () => {
    const result = await handleListContexts({}, "/nonexistent/path/that/does/not/exist");
    expect(result.error).toBeDefined();
    expect(result.entries).toEqual([]);
    expect(result.tracked).toBe(0);
    expect(result.total_directories).toBe(0);
  });

  it("uses path override instead of defaultRoot", async () => {
    const altRoot = await createTmpDir();
    try {
      await saveConfig(altRoot, { provider: "anthropic", min_tokens: 0 });
      await createFile(altRoot, "index.ts", "alt code");
      const fp = await computeFingerprint(altRoot);
      await writeContext(altRoot, makeValidContext({ fingerprint: fp, summary: "Alt" }));

      // defaultRoot is tmpDir (no context), path override points to altRoot
      const result = await handleListContexts({ path: altRoot }, tmpDir);
      expect(result.tracked).toBe(1);
      const root = result.entries.find((e) => e.scope === ".");
      expect(root!.summary).toBe("Alt");
    } finally {
      await cleanupTmpDir(altRoot);
    }
  });
});

// --- Additional coverage ---

describe("handleListContexts — skipped_directories", () => {
  it("reports skipped_directories when min_tokens filters subdirectories", async () => {
    // Use default config (no min_tokens: 0 override) so token filter is active
    await saveConfig(tmpDir, { provider: "anthropic" });

    // Root with a source file
    await createFile(tmpDir, "index.ts", "code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: rootFp, scope: "." }));

    // Tiny subdirectory that will be below the default 4096 token threshold
    const subDir = join(tmpDir, "tiny");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "small.ts", "x");

    const result = await handleListContexts({}, tmpDir);
    expect(result.skipped_directories).toBeGreaterThan(0);
  });
});

describe("handleQueryContext — file scope", () => {
  it("returns not found for scope pointing to a file", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    const result = await handleQueryContext({ scope: "index.ts" }, tmpDir);
    expect(result.found).toBe(false);
  });
});

// --- registerTools ---

describe("registerTools", () => {
  it("registers exactly 3 tools", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const registered: string[] = [];

    // Spy on registerTool by wrapping it
    const originalRegister = server.registerTool.bind(server);
    server.registerTool = (name: string, ...args: any[]) => {
      registered.push(name);
      return originalRegister(name, ...args);
    };

    registerTools(server, tmpDir);
    expect(registered).toHaveLength(12);
  });

  it("all tool names are correct", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const registered: string[] = [];

    const originalRegister = server.registerTool.bind(server);
    server.registerTool = (name: string, ...args: any[]) => {
      registered.push(name);
      return originalRegister(name, ...args);
    };

    registerTools(server, tmpDir);
    expect(registered).toContain("query_context");
    expect(registered).toContain("check_freshness");
    expect(registered).toContain("list_contexts");
    expect(registered).toContain("aggregate_evidence");
    expect(registered).toContain("explain_staleness");
    expect(registered).toContain("build_context_pack");
    expect(registered).toContain("check_policies");
    expect(registered).toContain("find_definition");
    expect(registered).toContain("find_references");
    expect(registered).toContain("find_related");
    expect(registered).toContain("search_context");
    expect(registered).toContain("impact");
  });

  it("tool descriptions are non-empty strings", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const descriptions: string[] = [];

    const originalRegister = server.registerTool.bind(server);
    server.registerTool = (name: string, config: any, ...args: any[]) => {
      descriptions.push(config.description);
      return originalRegister(name, config, ...args);
    };

    registerTools(server, tmpDir);
    for (const desc of descriptions) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });
});

// --- handleAggregateEvidence ---

describe("handleAggregateEvidence", () => {
  beforeEach(async () => {
    await saveConfig(tmpDir, { provider: "anthropic", min_tokens: 0 });
  });

  it("returns empty health when no scopes have evidence", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.scopes_with_evidence).toBe(0);
    expect(result.health.tests.passing).toBe(0);
    expect(result.health.tests.failing).toBe(0);
    expect(result.health.tests.total_test_count).toBe(0);
    expect(result.health.typecheck.clean).toBe(0);
    expect(result.health.lint.clean).toBe(0);
    expect(result.health.coverage.average_percent).toBeNull();
    expect(result.health.coverage.min_percent).toBeNull();
    expect(result.health.coverage.max_percent).toBeNull();
    expect(result.health.coverage.scopes_reported).toBe(0);
  });

  it("aggregates test_status across scopes with deterministic ordering", async () => {
    // Create scopes in non-alphabetical order to verify sorting
    const sub1 = join(tmpDir, "src");
    await mkdir(sub1, { recursive: true });
    await createFile(sub1, "app.ts", "app code");
    const sub1Fp = await computeFingerprint(sub1);
    await writeContext(sub1, makeValidContext({
      scope: "src",
      fingerprint: sub1Fp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "failing",
        test_count: 5,
        failing_tests: ["test1"],
      },
    }));

    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: rootFp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "passing",
        test_count: 10,
      },
    }));

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.scopes_with_evidence).toBe(2);
    expect(result.health.tests.passing).toBe(1);
    expect(result.health.tests.failing).toBe(1);
    expect(result.health.tests.total_test_count).toBe(15);
    expect(result.health.tests.failing_scopes).toEqual(["src"]);

    // Verify scopes are sorted lexicographically (. before src)
    const scopeOrder = result.scopes.map((s) => s.scope);
    expect(scopeOrder).toEqual([...scopeOrder].sort());
  });

  it("aggregates coverage metrics", async () => {
    const sub1 = join(tmpDir, "src");
    await mkdir(sub1, { recursive: true });
    await createFile(sub1, "app.ts", "app code");
    const sub1Fp = await computeFingerprint(sub1);
    await writeContext(sub1, makeValidContext({
      scope: "src",
      fingerprint: sub1Fp,
      evidence: { collected_at: "2026-02-18T00:00:00Z", coverage_percent: 80 },
    }));

    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: rootFp,
      evidence: { collected_at: "2026-02-18T00:00:00Z", coverage_percent: 90 },
    }));

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.health.coverage.scopes_reported).toBe(2);
    expect(result.health.coverage.average_percent).toBe(85);
    expect(result.health.coverage.min_percent).toBe(80);
    expect(result.health.coverage.max_percent).toBe(90);
  });

  it("returns per-scope evidence entries for all dirs", async () => {
    // Root: has context with evidence
    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: rootFp,
      evidence: { collected_at: "2026-02-18T00:00:00Z", test_status: "passing" },
    }));

    // Subdirectory: has context, no evidence
    const sub1 = join(tmpDir, "lib");
    await mkdir(sub1, { recursive: true });
    await createFile(sub1, "util.ts", "util code");
    const sub1Fp = await computeFingerprint(sub1);
    await writeContext(sub1, makeValidContext({ scope: "lib", fingerprint: sub1Fp }));

    // Subdirectory: no context at all
    const sub2 = join(tmpDir, "src");
    await mkdir(sub2, { recursive: true });
    await createFile(sub2, "app.ts", "app code");

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.total_scopes).toBe(3);
    expect(result.scopes).toHaveLength(3);

    const rootEntry = result.scopes.find((s) => s.scope === ".");
    expect(rootEntry!.has_evidence).toBe(true);
    expect(rootEntry!.evidence).toBeDefined();

    const libEntry = result.scopes.find((s) => s.scope === "lib");
    expect(libEntry!.has_evidence).toBe(false);
    expect(libEntry!.evidence).toBeUndefined();

    const srcEntry = result.scopes.find((s) => s.scope === "src");
    expect(srcEntry!.has_evidence).toBe(false);
  });

  it("handles global scan failure gracefully", async () => {
    const result = await handleAggregateEvidence({}, "/nonexistent/path/that/does/not/exist");
    expect(result.error).toBeDefined();
    expect(result.scopes).toEqual([]);
    expect(result.scope_errors).toEqual([]);
    expect(result.total_scopes).toBe(0);
    expect(result.scopes_with_evidence).toBe(0);
  });

  it("records scope_errors for unsupported version", async () => {
    // Root: valid context with evidence
    await createFile(tmpDir, "index.ts", "root code");
    const rootFp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: rootFp,
      evidence: { collected_at: "2026-02-18T00:00:00Z", test_status: "passing" },
    }));

    // Subdirectory: unsupported version 2 context
    const sub = join(tmpDir, "src");
    await mkdir(sub, { recursive: true });
    await createFile(sub, "app.ts", "app code");
    const v2Context = { ...makeValidContext({ scope: "src" }), version: 2 };
    await writeFile(join(sub, CONTEXT_FILENAME), stringify(v2Context));

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.scope_errors).toHaveLength(1);
    expect(result.scope_errors[0].scope).toBe("src");
    expect(result.scope_errors[0].error).toContain("Unsupported schema version");
    // Valid root still aggregated
    expect(result.scopes_with_evidence).toBe(1);
  });

  it("records scope_errors for corrupt .context.yaml", async () => {
    await createFile(tmpDir, "index.ts", "code");
    // Write a file that exists but is not valid YAML schema
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "not: valid\ncontext: file\n");

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.scope_errors).toHaveLength(1);
    expect(result.scope_errors[0].scope).toBe(".");
    expect(result.scope_errors[0].error).toContain("Invalid or corrupt");
    const rootEntry = result.scopes.find((s) => s.scope === ".");
    expect(rootEntry!.has_evidence).toBe(false);
  });

  it("handles minimal evidence (only collected_at)", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      evidence: { collected_at: "2026-02-18T00:00:00Z" },
    }));

    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.scopes_with_evidence).toBe(1);
    const rootEntry = result.scopes.find((s) => s.scope === ".");
    expect(rootEntry!.has_evidence).toBe(true);
    // Health counters should not increment for missing optional fields
    expect(result.health.tests.passing).toBe(0);
    expect(result.health.tests.failing).toBe(0);
    expect(result.health.tests.unknown).toBe(0);
    expect(result.health.tests.total_test_count).toBe(0);
    expect(result.health.typecheck.clean).toBe(0);
    expect(result.health.lint.clean).toBe(0);
    expect(result.health.coverage.scopes_reported).toBe(0);
  });

  it("uses path override instead of defaultRoot", async () => {
    const altRoot = await createTmpDir();
    try {
      await saveConfig(altRoot, { provider: "anthropic", min_tokens: 0 });
      await createFile(altRoot, "index.ts", "alt code");
      const fp = await computeFingerprint(altRoot);
      await writeContext(altRoot, makeValidContext({
        fingerprint: fp,
        evidence: { collected_at: "2026-02-18T00:00:00Z", test_status: "passing", test_count: 7 },
      }));

      // defaultRoot is tmpDir (no context), path override points to altRoot
      const result = await handleAggregateEvidence({ path: altRoot }, tmpDir);
      expect(result.scopes_with_evidence).toBe(1);
      expect(result.health.tests.passing).toBe(1);
      expect(result.health.tests.total_test_count).toBe(7);
    } finally {
      await cleanupTmpDir(altRoot);
    }
  });
});
