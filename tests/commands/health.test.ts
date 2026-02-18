import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { healthCommand } from "../../src/commands/health.js";
import { writeContext } from "../../src/core/writer.js";
import { computeFingerprint } from "../../src/core/fingerprint.js";
import { saveConfig } from "../../src/utils/config.js";
import { createTmpDir, cleanupTmpDir, createFile, makeValidContext } from "../helpers.js";

let tmpDir: string;
let logs: string[];

beforeEach(async () => {
  tmpDir = await createTmpDir();
  await saveConfig(tmpDir, { provider: "anthropic", min_tokens: 0 });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

describe("healthCommand (human-readable)", () => {
  it("shows health summary with Tests, Typecheck, Lint", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "passing",
        test_count: 42,
        typecheck: "clean",
        lint_status: "clean",
        coverage_percent: 85,
      },
    }));

    await healthCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("Code Health");
    expect(output).toContain("Tests:");
    expect(output).toContain("1 passing");
    expect(output).toContain("42 total tests");
    expect(output).toContain("Typecheck:");
    expect(output).toContain("1 clean");
    expect(output).toContain("Lint:");
    expect(output).toContain("Coverage:");
    expect(output).toContain("1 of 1 scopes report evidence");
  });

  it("shows no-evidence message when no evidence exists", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    await healthCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("No evidence found");
  });

  it("shows Failing line when tests are failing", async () => {
    const sub = join(tmpDir, "src");
    await mkdir(sub, { recursive: true });
    await createFile(sub, "app.ts", "app code");
    const subFp = await computeFingerprint(sub);
    await writeContext(sub, makeValidContext({
      scope: "src",
      fingerprint: subFp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "failing",
        test_count: 5,
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

    await healthCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("Failing:");
    expect(output).toContain("src");
  });

  it("omits Failing line when all tests pass", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "passing",
        test_count: 10,
      },
    }));

    await healthCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).not.toContain("Failing:");
  });
});

describe("healthCommand --json", () => {
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  it("outputs valid JSON with AggregateEvidenceResult shape", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({
      fingerprint: fp,
      evidence: {
        collected_at: "2026-02-18T00:00:00Z",
        test_status: "passing",
        test_count: 10,
        coverage_percent: 90,
      },
    }));

    await healthCommand({ path: tmpDir, json: true });

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed).toHaveProperty("root");
    expect(parsed).toHaveProperty("total_scopes");
    expect(parsed).toHaveProperty("scopes_with_evidence");
    expect(parsed).toHaveProperty("health");
    expect(parsed).toHaveProperty("scopes");
    expect(parsed).toHaveProperty("scope_errors");
    expect(parsed.health).toHaveProperty("tests");
    expect(parsed.health).toHaveProperty("typecheck");
    expect(parsed.health).toHaveProperty("lint");
    expect(parsed.health).toHaveProperty("coverage");
    expect(parsed.total_scopes).toBe(1);
    expect(parsed.scopes_with_evidence).toBe(1);
    expect(parsed.health.tests.passing).toBe(1);
    expect(parsed.health.coverage.average_percent).toBe(90);
  });
});
