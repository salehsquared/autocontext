import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTmpDir,
  cleanupTmpDir,
  createNestedFile,
  makeValidContext,
} from "../helpers.js";
import { writeContext, writeConfig } from "../../src/core/writer.js";
import { collectViewData } from "../../src/view/collect.js";

async function enableAllScopes(dir: string): Promise<void> {
  await writeConfig(dir, { provider: "anthropic", min_tokens: 0 });
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("collectViewData", () => {
  it("produces a ViewData with graceful degradation when T1/T2/T4 artifacts are absent", async () => {
    await enableAllScopes(tmpDir);
    await mkdir(join(tmpDir, "src/core"), { recursive: true });
    await createNestedFile(tmpDir, "src/core/math.ts", "export const x = 1;\n");
    await writeContext(
      tmpDir,
      makeValidContext({
        scope: ".",
        summary: "Root context",
        project: { name: "demo", description: "demo", language: "ts" },
      }),
    );
    await writeContext(
      join(tmpDir, "src/core"),
      makeValidContext({
        scope: "src/core",
        summary: "Core",
        exports: ["computeFingerprint"],
        decisions: [{ what: "split", why: "reasons" }],
      }),
    );

    const data = await collectViewData({
      projectRoot: tmpDir,
      autocontextVersion: "test",
      generatedAt: "2026-01-01T00:00:00Z",
      indexPresent: false,
    });

    expect(data.has_index).toBe(false);
    expect(data.has_policy).toBe(false);
    expect(data.has_semantic_staleness).toBe(false);
    expect(data.dir_edges).toEqual([]);
    const scopes = data.scopes.map((s) => s.scope).sort();
    expect(scopes).toContain(".");
    expect(scopes).toContain("src/core");
    const core = data.scopes.find((s) => s.scope === "src/core")!;
    expect(core.summary).toBe("Core");
    expect(core.decisions[0].what).toBe("split");
    expect(core.exports.map((e) => e.name)).toContain("computeFingerprint");
    expect(core.raw_yaml.length).toBeGreaterThan(0);
  });

  it("flags has_policy when .autocontext/policy-results.json exists and attaches violations", async () => {
    await enableAllScopes(tmpDir);
    await mkdir(join(tmpDir, ".autocontext"), { recursive: true });
    await writeContext(tmpDir, makeValidContext({ scope: ".", summary: "root" }));
    await createNestedFile(tmpDir, "src/a.ts", "export const v = 1;\n");
    await writeContext(join(tmpDir, "src"), makeValidContext({ scope: "src", summary: "src" }));
    await writeFile(
      join(tmpDir, ".autocontext/policy-results.json"),
      JSON.stringify({
        violations: [
          { rule_kind: "forbid_import", scope: "src", message: "no", file: "src/a.ts", line: 4 },
        ],
      }),
    );

    const data = await collectViewData({
      projectRoot: tmpDir,
      autocontextVersion: "test",
      indexPresent: false,
    });
    expect(data.has_policy).toBe(true);
    const srcScope = data.scopes.find((s) => s.scope === "src");
    expect(srcScope?.violations.length).toBe(1);
    expect(srcScope?.violations[0].rule_kind).toBe("forbid_import");
  });

  it("rolls up totals (fresh/stale/missing/violations)", async () => {
    await writeContext(tmpDir, makeValidContext({ scope: ".", summary: "root" }));
    const data = await collectViewData({
      projectRoot: tmpDir,
      autocontextVersion: "test",
      indexPresent: false,
    });
    const sum = data.totals.fresh + data.totals.stale + data.totals.missing + data.totals.semantic_stale + data.totals.cosmetic_stale;
    expect(sum).toBe(data.scopes.length);
  });
});
