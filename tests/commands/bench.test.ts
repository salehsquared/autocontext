import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchReport } from "../../src/bench/types.js";
import { createTmpDir, cleanupTmpDir, makeValidContext } from "../helpers.js";

const loadConfigMock = vi.fn();
const resolveApiKeyMock = vi.fn();
const loadScanOptionsMock = vi.fn();
const createProviderMock = vi.fn();
const scanProjectMock = vi.fn();
const flattenBottomUpMock = vi.fn();
const readContextMock = vi.fn();
const checkFreshnessMock = vi.fn();
const buildDepSetsMock = vi.fn();
const buildReverseDepsMock = vi.fn();
const buildDirFactsMock = vi.fn();
const isGitRepoMock = vi.fn();
const getFixCommitsMock = vi.fn();
const getFeatureCommitsMock = vi.fn();
const generateTasksMock = vi.fn();
const runBenchMock = vi.fn();
const aggregateResultsMock = vi.fn();
const aggregateMultiRepoMock = vi.fn();
const cleanupReposMock = vi.fn(async () => {});
const cloneRepoMock = vi.fn();
const initCommandMock = vi.fn();

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: loadConfigMock,
  resolveApiKey: resolveApiKeyMock,
}));

vi.mock("../../src/utils/scan-options.js", () => ({
  loadScanOptions: loadScanOptionsMock,
}));

vi.mock("../../src/providers/index.js", () => ({
  createProvider: createProviderMock,
}));

vi.mock("../../src/core/scanner.js", () => ({
  scanProject: scanProjectMock,
  flattenBottomUp: flattenBottomUpMock,
}));

vi.mock("../../src/core/writer.js", () => ({
  readContext: readContextMock,
}));

vi.mock("../../src/core/fingerprint.js", () => ({
  checkFreshness: checkFreshnessMock,
  legacyState: (s: string) => (s === "fresh" || s === "missing" ? s : "stale"),
}));

vi.mock("../../src/bench/ground-truth.js", () => ({
  buildDepSets: buildDepSetsMock,
  buildReverseDeps: buildReverseDepsMock,
  buildDirFacts: buildDirFactsMock,
}));

vi.mock("../../src/bench/git.js", () => ({
  isGitRepo: isGitRepoMock,
  getFixCommits: getFixCommitsMock,
  getFeatureCommits: getFeatureCommitsMock,
  cloneRepo: cloneRepoMock,
}));

vi.mock("../../src/bench/tasks.js", () => ({
  generateTasks: generateTasksMock,
}));

vi.mock("../../src/bench/runner.js", () => ({
  runBench: runBenchMock,
}));

vi.mock("../../src/bench/scorer.js", () => ({
  aggregateResults: aggregateResultsMock,
  aggregateMultiRepo: aggregateMultiRepoMock,
}));

vi.mock("../../src/bench/repos.js", () => ({
  DEFAULT_REPOS: [],
  cleanupRepos: cleanupReposMock,
}));

vi.mock("../../src/commands/init.js", () => ({
  initCommand: initCommandMock,
}));

const { benchCommand } = await import("../../src/commands/bench.js");

function makeReport(rootPath: string): BenchReport {
  return {
    root: rootPath,
    provider: "openai",
    model: "gpt-4o-mini",
    iterations: 1,
    seed: 42,
    timestamp: "2026-01-01T00:00:00.000Z",
    task_count: 1,
    baseline: {
      condition: "baseline",
      tasks_run: 1,
      mean_score: 0.5,
      stddev_score: 0,
      abstention_rate: 0,
      mean_latency_ms: 100,
      total_answer_tokens_est: 100,
      total_judge_tokens_est: 20,
      total_tokens_est: 120,
      cost_per_correct: 120,
      by_category: {},
    },
    context: {
      condition: "context",
      tasks_run: 1,
      mean_score: 0.6,
      stddev_score: 0,
      abstention_rate: 0,
      mean_latency_ms: 90,
      total_answer_tokens_est: 80,
      total_judge_tokens_est: 20,
      total_tokens_est: 100,
      cost_per_correct: 100,
      by_category: {},
    },
    delta: {
      accuracy_gain: 0.1,
      abstention_reduction: 0,
      token_reduction: 0.1667,
      cost_per_correct_reduction: 0.1667,
    },
    tasks: [
      {
        id: "t-1",
        category: "comprehension",
        question: "What does this module do?",
        scoring: "llm_judge",
        expected: ["src/index.ts"],
        source_scope: ".",
      },
    ],
    results: [],
  };
}

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await createTmpDir();
  process.exitCode = undefined;

  loadConfigMock.mockResolvedValue({
    provider: "openai",
    model: "gpt-4o-mini",
  });
  resolveApiKeyMock.mockReturnValue("test-key");
  loadScanOptionsMock.mockResolvedValue({});
  createProviderMock.mockResolvedValue({ generate: vi.fn(async () => "answer") });
  scanProjectMock.mockImplementation(async (rootPath: string) => ({
    path: rootPath,
    relativePath: ".",
    files: ["index.ts"],
    hasContext: true,
    children: [],
  }));
  flattenBottomUpMock.mockImplementation((scanResult: unknown) => [scanResult]);
  readContextMock.mockResolvedValue(makeValidContext({ fingerprint: "abc12345" }));
  checkFreshnessMock.mockResolvedValue({ state: "fresh" });
  buildDepSetsMock.mockResolvedValue(new Map());
  buildReverseDepsMock.mockResolvedValue(new Map());
  buildDirFactsMock.mockResolvedValue(new Map());
  isGitRepoMock.mockReturnValue(false);
  getFixCommitsMock.mockReturnValue([]);
  getFeatureCommitsMock.mockReturnValue([]);
  generateTasksMock.mockResolvedValue([
    {
      id: "t-1",
      category: "comprehension",
      question: "What does this module do?",
      scoring: "llm_judge",
      expected: ["src/index.ts"],
      source_scope: ".",
    },
  ]);
  runBenchMock.mockResolvedValue([]);
  aggregateResultsMock.mockImplementation((rootPath: string) => makeReport(rootPath));
  aggregateMultiRepoMock.mockReturnValue({});

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
  process.exitCode = undefined;
});

describe("benchCommand", () => {
  it("fails with a clear error when provider is not configured", async () => {
    loadConfigMock.mockResolvedValue(null);

    await expect(benchCommand({ path: tmpDir, json: true })).rejects.toThrow("No provider configured");
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No provider configured"));
  });

  it("blocks stale contexts by default", async () => {
    checkFreshnessMock.mockResolvedValue({ state: "stale" });

    await expect(benchCommand({ path: tmpDir, json: true })).rejects.toThrow("Stale contexts");
    expect(process.exitCode).toBe(1);
    expect(generateTasksMock).not.toHaveBeenCalled();
  });

  it("allows stale contexts with --allow-stale and still emits JSON", async () => {
    checkFreshnessMock.mockResolvedValue({ state: "stale" });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });

    await benchCommand({ path: tmpDir, json: true, allowStale: true });

    expect(checkFreshnessMock).not.toHaveBeenCalled();
    expect(generateTasksMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed).toMatchObject({
      root: tmpDir,
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("writes JSON report to --out in JSON mode", async () => {
    const outPath = join(tmpDir, "report.json");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await benchCommand({ path: tmpDir, json: true, out: outPath, allowStale: true });

    const raw = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      root: tmpDir,
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("propagates write errors for --out paths that are not writable", async () => {
    const outPath = join(tmpDir, "missing-dir", "report.json");

    await expect(
      benchCommand({ path: tmpDir, json: true, out: outPath, allowStale: true }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });
});
