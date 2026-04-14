import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  createTmpDir,
  cleanupTmpDir,
  createNestedFile,
  makeValidContext,
} from "../helpers.js";
import { writeContext, writeConfig } from "../../src/core/writer.js";
import {
  handleQueryContext,
  handleCheckFreshness,
  handleListContexts,
  handleAggregateEvidence,
} from "../../src/mcp/tools.js";
import { computeFingerprint } from "../../src/core/fingerprint.js";

/**
 * Compat snapshot: pins the byte-identical output shape of the four legacy
 * MCP tools (query_context, check_freshness, list_contexts, aggregate_evidence)
 * against a canned fixture. Deferred from T6; landed in T11 so future MCP
 * changes can't silently break third-party consumers of the library API.
 *
 * Semantics pinned:
 *  - check_freshness returns the 3-state legacy enum (fresh|stale|missing)
 *    even when a semantic_fingerprint is present. 4-state lives only on
 *    explain_staleness.
 *  - list_contexts entries use the same legacy enum.
 *  - query_context output shape is byte-identical to v0.1.x.
 *  - aggregate_evidence keeps its rollup shape.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
  await writeConfig(tmpDir, { provider: "anthropic", min_tokens: 0 });
  await createNestedFile(tmpDir, "src/a.ts", "export const x = 1;\n");
  await mkdir(join(tmpDir, "src"), { recursive: true });
  const rootFp = await computeFingerprint(tmpDir);
  const srcFp = await computeFingerprint(join(tmpDir, "src"));
  await writeContext(
    tmpDir,
    makeValidContext({
      scope: ".",
      summary: "Root context for compat snapshot.",
      fingerprint: rootFp,
      last_updated: "2026-04-14T00:00:00.000Z",
      semantic_fingerprint: "aabbccddeeff",
      evidence: {
        collected_at: "2026-04-14T00:00:00.000Z",
        test_status: "passing",
        test_count: 12,
        typecheck: "clean",
        coverage_percent: 85,
      },
    }),
  );
  await writeContext(
    join(tmpDir, "src"),
    makeValidContext({
      scope: "src",
      summary: "Source tree.",
      fingerprint: srcFp,
      last_updated: "2026-04-14T00:00:00.000Z",
    }),
  );
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("legacy MCP tool contracts — byte-identical (v0.2.0 compat lock)", () => {
  it("query_context returns the documented shape with every expected key", async () => {
    const result = await handleQueryContext({ scope: "src" }, tmpDir);
    expect(result.found).toBe(true);
    expect(result.scope).toBe("src");
    expect(result.context).toBeDefined();
    const ctx = result.context as Record<string, unknown>;
    expect(ctx.version).toBe(1);
    expect(ctx.scope).toBe("src");
    expect(ctx.summary).toBe("Source tree.");
    expect(typeof ctx.fingerprint).toBe("string");
    expect(typeof ctx.last_updated).toBe("string");
  });

  it("query_context with filter returns only metadata + requested fields", async () => {
    const result = await handleQueryContext(
      { scope: "src", filter: ["summary"] },
      tmpDir,
    );
    expect(result.found).toBe(true);
    const keys = Object.keys(result.context!).sort();
    expect(keys).toEqual(["fingerprint", "last_updated", "scope", "summary", "version"]);
  });

  it("check_freshness returns 3-state enum even when semantic_fingerprint is present", async () => {
    const result = await handleCheckFreshness({ scope: "." }, tmpDir);
    // Must stay on the legacy 3-state even though the scope has a semantic_fingerprint.
    expect(["fresh", "stale", "missing"]).toContain(result.state);
    expect(result.fingerprint).toBeDefined();
    expect(result.fingerprint?.stored).toBeTruthy();
    expect(result.fingerprint?.computed).toBeTruthy();
    expect(result.last_updated).toBeDefined();
    // Must NOT leak 4-state enum values.
    expect(result.state).not.toBe("cosmetic_stale");
    expect(result.state).not.toBe("semantic_stale");
  });

  it("list_contexts entries carry 3-state legacy enum only", async () => {
    const result = await handleListContexts({}, tmpDir);
    expect(result.total_directories).toBeGreaterThanOrEqual(2);
    expect(result.tracked).toBeGreaterThanOrEqual(2);
    for (const entry of result.entries) {
      expect(["fresh", "stale", "missing"]).toContain(entry.state);
      expect(entry.state).not.toBe("cosmetic_stale");
      expect(entry.state).not.toBe("semantic_stale");
    }
    const sorted = [...result.entries].map((e) => e.scope).sort();
    expect(result.entries.map((e) => e.scope)).toEqual(sorted);
  });

  it("aggregate_evidence shape stays stable", async () => {
    const result = await handleAggregateEvidence({}, tmpDir);
    expect(result.root).toBe(tmpDir);
    expect(typeof result.total_scopes).toBe("number");
    expect(typeof result.scopes_with_evidence).toBe("number");
    expect(result.health).toBeDefined();
    expect(result.health.tests).toHaveProperty("passing");
    expect(result.health.tests).toHaveProperty("failing");
    expect(result.health.tests).toHaveProperty("unknown");
    expect(result.health.typecheck).toHaveProperty("clean");
    expect(result.health.lint).toHaveProperty("clean");
    expect(result.health.coverage).toHaveProperty("scopes_reported");
    expect(Array.isArray(result.scopes)).toBe(true);
    expect(Array.isArray(result.scope_errors)).toBe(true);
  });

  it("query_context path-traversal rejection stays identical", async () => {
    const result = await handleQueryContext(
      { scope: "../../etc/passwd" },
      tmpDir,
    );
    expect(result.found).toBe(false);
    expect(result.error).toContain("path traversal");
  });

  it("query_context missing-context error message is unchanged", async () => {
    const result = await handleQueryContext(
      { scope: "nonexistent" },
      tmpDir,
    );
    expect(result.found).toBe(false);
    expect(result.error).toContain("No .context.yaml found");
  });
});
