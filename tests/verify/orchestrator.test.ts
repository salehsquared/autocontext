import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createTmpDir, cleanupTmpDir, makeValidContext } from "../helpers.js";
import { writeContext, writeConfig } from "../../src/core/writer.js";
import { runVerify } from "../../src/verify/orchestrator.js";
import type { SpawnResult } from "../../src/verify/runner.js";
import type { ConfigFile } from "../../src/core/schema.js";
import { parse as parseYaml } from "yaml";
import { getVerifyCommand } from "../../src/utils/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

function makeSpawn(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

describe("runVerify — orchestration", () => {
  it("writes merged evidence back to .context.yaml and reports ok", async () => {
    await writeContext(tmpDir, makeValidContext({ scope: "." }));
    const config: ConfigFile = {
      provider: "anthropic",
      verify: {
        test: { command: "mock-test" },
        typecheck: { command: "mock-tsc" },
      },
    };
    await writeConfig(tmpDir, config);

    const report = await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: false,
      runFn: async (cmd) => {
        if (cmd === "mock-test") return makeSpawn({ stdout: '{"success":true,"numTotalTests":3}' });
        return makeSpawn({ exitCode: 0 });
      },
      shaFn: async () => "deadbeefcafe",
    });

    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0].status).toBe("ok");
    expect(report.scopes[0].evidence_written).toBe(true);

    const content = await readFile(join(tmpDir, ".context.yaml"), "utf-8");
    const doc = parseYaml(content);
    expect(doc.evidence.test_status).toBe("passing");
    expect(doc.evidence.test_count).toBe(3);
    expect(doc.evidence.typecheck).toBe("clean");
    expect(doc.evidence.commit_sha).toBe("deadbeefcafe");
  });

  it("replaces evidence by default, merges with opts.merge", async () => {
    const existing = makeValidContext({
      scope: ".",
      evidence: {
        collected_at: "2026-01-01T00:00:00Z",
        lint_status: "clean",
        test_status: "failing",
      },
    });
    await writeContext(tmpDir, existing);
    const config: ConfigFile = {
      provider: "anthropic",
      verify: { test: "mock-test" },
    };
    await writeConfig(tmpDir, config);
    const runFn = async () => makeSpawn({ stdout: '{"success":true,"numTotalTests":1}' });

    // replacement (default)
    await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: false,
      runFn,
      shaFn: async () => null,
    });
    let doc = parseYaml(await readFile(join(tmpDir, ".context.yaml"), "utf-8"));
    expect(doc.evidence.lint_status).toBeUndefined(); // dropped
    expect(doc.evidence.test_status).toBe("passing");

    // merge preserves existing fields
    await writeContext(tmpDir, { ...existing, evidence: existing.evidence });
    await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: true,
      dryRun: false,
      runFn,
      shaFn: async () => null,
    });
    doc = parseYaml(await readFile(join(tmpDir, ".context.yaml"), "utf-8"));
    expect(doc.evidence.lint_status).toBe("clean"); // preserved
    expect(doc.evidence.test_status).toBe("passing");
  });

  it("partial success writes what it has and flips status to partial", async () => {
    await writeContext(tmpDir, makeValidContext({ scope: "." }));
    const config: ConfigFile = {
      provider: "anthropic",
      verify: {
        test: "mock-test",
        typecheck: "mock-tsc",
      },
    };
    await writeConfig(tmpDir, config);
    const report = await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: false,
      runFn: async (cmd) => {
        if (cmd === "mock-test") return makeSpawn({ stdout: '{"success":true,"numTotalTests":1}' });
        return makeSpawn({ exitCode: 1, stderr: "error TS2304: cannot find" });
      },
      shaFn: async () => null,
    });
    expect(report.scopes[0].status).toBe("partial");
    expect(report.scopes[0].evidence_written).toBe(true);
  });

  it("dryRun emits the plan without spawning or writing", async () => {
    await writeContext(tmpDir, makeValidContext({ scope: "." }));
    const config: ConfigFile = {
      provider: "anthropic",
      verify: { test: "mock-test" },
    };
    await writeConfig(tmpDir, config);
    let called = false;
    const report = await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: true,
      runFn: async () => {
        called = true;
        return makeSpawn();
      },
    });
    expect(called).toBe(false);
    expect(report.scopes[0].evidence_written).toBe(false);
    // still populates `ran` with the planned command
    expect(report.scopes[0].ran.map((r) => r.kind)).toEqual(["test"]);
  });

  it("honors onlyKinds filter", async () => {
    await writeContext(tmpDir, makeValidContext({ scope: "." }));
    const config: ConfigFile = {
      provider: "anthropic",
      verify: { test: "mock-test", typecheck: "mock-tsc" },
    };
    await writeConfig(tmpDir, config);
    const report = await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: false,
      onlyKinds: new Set(["test"]),
      runFn: async () => makeSpawn({ stdout: '{"success":true,"numTotalTests":2}' }),
      shaFn: async () => null,
    });
    const kinds = report.scopes[0].ran.map((r) => r.kind);
    expect(kinds).toEqual(["test"]);
    expect(report.scopes[0].skipped.some((s) => s.kind === "typecheck" && s.reason === "filtered_out")).toBe(true);
  });

  it("reports no_context when the scope has no .context.yaml", async () => {
    const config: ConfigFile = {
      provider: "anthropic",
      verify: { test: "mock-test" },
    };
    await writeConfig(tmpDir, config);
    const report = await runVerify({
      projectRoot: tmpDir,
      scopes: [{ relative: ".", absolute: tmpDir }],
      config,
      merge: false,
      dryRun: false,
      runFn: async () => makeSpawn({ stdout: '{"success":true,"numTotalTests":1}' }),
      shaFn: async () => null,
    });
    expect(report.scopes[0].status).toBe("no_context");
    expect(report.scopes[0].evidence_written).toBe(false);
  });
});

describe("getVerifyCommand — per-scope overrides", () => {
  it("resolves deepest override first, falls back to root", () => {
    const config: ConfigFile = {
      provider: "anthropic",
      verify: {
        test: "root-test",
        scope_overrides: {
          "src/cli": { test: "cli-test" },
          "src/cli/deep": { test: "deep-test" },
        },
      },
    };
    expect(getVerifyCommand(config, "test", "src/cli/deep")).toBe("deep-test");
    expect(getVerifyCommand(config, "test", "src/cli/other")).toBe("cli-test");
    expect(getVerifyCommand(config, "test", "src/other")).toBe("root-test");
    expect(getVerifyCommand(config, "test", ".")).toBe("root-test");
  });

  it("returns undefined when not configured at any level", () => {
    const config: ConfigFile = {
      provider: "anthropic",
      verify: { test: "root-test" },
    };
    expect(getVerifyCommand(config, "typecheck", "src/cli")).toBeUndefined();
  });
});
