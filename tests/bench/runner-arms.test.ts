import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeScanResult, makeValidContext } from "../helpers.js";
import type { BenchTask } from "../../src/bench/types.js";
import type { Pack } from "../../src/pack/types.js";

const buildPackMock = vi.fn<() => Promise<Pack>>();
const openReadOnlyIndexMock = vi.fn();
const computeImpactMock = vi.fn();

vi.mock("../../src/pack/pack.js", () => ({
  buildPack: buildPackMock,
}));

vi.mock("../../src/index/access.js", () => ({
  openReadOnlyIndex: openReadOnlyIndexMock,
}));

vi.mock("../../src/impact/impact.js", () => ({
  computeImpact: computeImpactMock,
}));

const { runBench } = await import("../../src/bench/runner.js");

function makePack(scope = "src/core"): Pack {
  return {
    seed: { kind: "query", value: "seed" },
    budget: 4000,
    used_tokens: 140,
    root: { scope: ".", summary: "Root summary" },
    scopes: [
      {
        scope,
        score: 0.9,
        hops: 1,
        rendered: "scope: src/core\nsummary: Main core area",
        mustInclude: false,
        context: makeValidContext({
          scope,
          summary: "Main core area",
          exports: ["Thing"],
        }),
        tokens: 80,
      },
    ],
    warnings: [],
    metadata: {
      autocontext_version: "0.2.0",
      n_scopes_considered: 3,
      truncated: false,
    },
  };
}

describe("runBench pack-family arms", () => {
  const scanResult = makeScanResult("/tmp/project", {
    files: ["README.md"],
    children: [
      makeScanResult("/tmp/project/src", {
        relativePath: "src",
        files: ["index.ts"],
      }),
    ],
  });

  const contextFiles = new Map([
    [".", makeValidContext({ scope: ".", summary: "Root context" })],
    ["src", makeValidContext({ scope: "src", summary: "Source context" })],
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    buildPackMock.mockResolvedValue(makePack());
    openReadOnlyIndexMock.mockResolvedValue({
      state: "ready",
      store: {
        findSymbolsByName: vi.fn(async () => [{ file: "src/index.ts", name: "Thing" }]),
        close: vi.fn(async () => {}),
      },
    });
    computeImpactMock.mockResolvedValue({
      seeds: [{ file: "src/index.ts", reason: "file" }],
      affected: [],
      affected_scopes: [{ scope: "src/core", min_hops: 1, file_count: 2 }],
      stopped: [],
      caveat: "impact caveat",
    });
  });

  it("pack arm builds from the explicit task seed and records a cache key", async () => {
    const provider = { generate: vi.fn().mockResolvedValue("2") };
    const tasks: BenchTask[] = [{
      id: "pack-task",
      category: "find-definition",
      question: "Which file defines Thing?",
      scoring: "llm_judge",
      expected: ["src/index.ts"],
      source_scope: "src",
      task_seed: { kind: "symbol", value: "Thing" },
    }];

    const results = await runBench({
      projectRoot: "/tmp/project",
      tasks,
      provider,
      providerName: "openai",
      modelName: "gpt-4o-mini",
      scanResult,
      readme: null,
      contextFiles,
      iterations: 1,
      armSet: ["pack"],
    });

    expect(buildPackMock).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/tmp/project",
      symbol: "Thing",
    }));
    expect(provider.generate.mock.calls[0][1]).toContain("retrieval-ranked project pack");
    expect(results[0].condition).toBe("pack");
    expect(results[0].pack_cache_key).toBeTruthy();
  });

  it("pack+impact falls back to plain pack with a warning when no task seed exists", async () => {
    const provider = { generate: vi.fn().mockResolvedValue("2") };
    const tasks: BenchTask[] = [{
      id: "impact-fallback",
      category: "comprehension",
      question: "What does src do?",
      scoring: "llm_judge",
      expected: ["Files: src/index.ts"],
      source_scope: "src",
    }];

    const results = await runBench({
      projectRoot: "/tmp/project",
      tasks,
      provider,
      providerName: "openai",
      modelName: "gpt-4o-mini",
      scanResult,
      readme: null,
      contextFiles,
      iterations: 1,
      armSet: ["pack+impact"],
    });

    expect(computeImpactMock).not.toHaveBeenCalled();
    expect(provider.generate.mock.calls[0][1]).not.toContain("Impact set");
    expect(results[0].warnings).toEqual([{ kind: "impact_seed_unavailable" }]);
  });

  it("pack+impact includes the impact section when a file seed is available", async () => {
    const provider = { generate: vi.fn().mockResolvedValue("2") };
    const tasks: BenchTask[] = [{
      id: "impact-task",
      category: "impact-of-change",
      question: "If src/index.ts changes, which scopes are affected?",
      scoring: "file_set_f1",
      expected: ["src/core"],
      source_scope: "src",
      task_seed: { kind: "file", value: "src/index.ts" },
    }];

    await runBench({
      projectRoot: "/tmp/project",
      tasks,
      provider,
      providerName: "openai",
      modelName: "gpt-4o-mini",
      scanResult,
      readme: null,
      contextFiles,
      iterations: 1,
      armSet: ["pack+impact"],
    });

    expect(computeImpactMock).toHaveBeenCalledTimes(1);
    expect(provider.generate.mock.calls[0][1]).toContain("Impact set");
    expect(provider.generate.mock.calls[0][1]).toContain("src/core");
  });

  it("pack+policy only includes violations that overlap the admitted pack scopes", async () => {
    const provider = { generate: vi.fn().mockResolvedValue("2") };
    const tasks: BenchTask[] = [{
      id: "policy-task",
      category: "task_routing",
      question: "Where should I add a new command?",
      scoring: "target_hit",
      expected: ["src/core"],
      source_scope: "src",
      task_seed: { kind: "query", value: "new command" },
    }];

    await runBench({
      projectRoot: "/tmp/project",
      tasks,
      provider,
      providerName: "openai",
      modelName: "gpt-4o-mini",
      scanResult,
      readme: null,
      contextFiles,
      iterations: 1,
      armSet: ["pack+policy"],
      policyViolations: [
        {
          rule_kind: "forbid_import",
          scope: "src/core",
          message: "core violation",
          file: "src/core/index.ts",
          severity: "error",
          rule_index: 0,
        },
        {
          rule_kind: "forbid_import",
          scope: "tests",
          message: "test violation",
          file: "tests/example.test.ts",
          severity: "error",
          rule_index: 1,
        },
      ],
    });

    const prompt = provider.generate.mock.calls[0][1];
    expect(prompt).toContain("Policy violations");
    expect(prompt).toContain("core violation");
    expect(prompt).not.toContain("test violation");
  });
});
