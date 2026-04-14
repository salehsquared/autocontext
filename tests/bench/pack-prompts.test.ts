import { describe, it, expect } from "vitest";
import {
  buildPackPrompt,
  buildPackImpactPrompt,
  buildPackPolicyPrompt,
} from "../../src/bench/prompts.js";
import type { Pack } from "../../src/pack/types.js";
import type { ImpactReport } from "../../src/impact/impact.js";
import type { Violation } from "../../src/policy/types.js";

function mockPack(): Pack {
  return {
    seed: { kind: "query", value: "test" },
    budget: 4000,
    used_tokens: 130,
    root: { scope: ".", summary: "Root summary" },
    scopes: [
      {
        scope: "src/core",
        score: 0.9,
        hops: 1,
        rendered: "scope: src/core\nsummary: Fingerprinting",
        mustInclude: false,
        context: {
          version: 1,
          last_updated: "2026-04-14T00:00:00Z",
          fingerprint: "aaaa1111",
          scope: "src/core",
          summary: "Fingerprinting",
          maintenance: "Keep updated",
        },
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

describe("buildPackPrompt", () => {
  it("includes pack markdown + the question", () => {
    const prompt = buildPackPrompt(mockPack(), "What is the root summary?");
    expect(prompt).toContain("autocontext:pack:meta");
    expect(prompt).toContain("What is the root summary?");
  });

  it("mentions the scope focus when provided", () => {
    const prompt = buildPackPrompt(mockPack(), "Q", "src/core");
    expect(prompt).toContain("centered on `src/core/`");
  });
});

describe("buildPackImpactPrompt", () => {
  it("appends impact scopes below the pack", () => {
    const impact: ImpactReport = {
      seeds: [{ file: "src/a.ts", reason: "file" }],
      affected: [],
      affected_scopes: [
        { scope: "src/api", min_hops: 1, file_count: 3 },
        { scope: "src/core", min_hops: 2, file_count: 5 },
      ],
      stopped: [],
      caveat: "pinned caveat",
    };
    const prompt = buildPackImpactPrompt(mockPack(), impact, "Q");
    expect(prompt).toContain("Impact set");
    expect(prompt).toContain("src/api");
    expect(prompt).toContain("src/core");
    expect(prompt).toContain("pinned caveat");
  });

  it("is identical to buildPackPrompt when impact is null", () => {
    const base = buildPackPrompt(mockPack(), "Q");
    const withNull = buildPackImpactPrompt(mockPack(), null, "Q");
    expect(withNull).toBe(base);
  });
});

describe("buildPackPolicyPrompt", () => {
  it("lists violations with rule kind + location", () => {
    const violations: Violation[] = [
      {
        rule_kind: "forbid_import",
        scope: "src/server",
        message: "bad import",
        file: "src/server/api.ts",
        line: 4,
        to: "src/client/types.ts",
        severity: "error",
        rule_index: 0,
      },
    ];
    const prompt = buildPackPolicyPrompt(mockPack(), violations, "Q");
    expect(prompt).toContain("Policy violations");
    expect(prompt).toContain("[forbid_import]");
    expect(prompt).toContain("src/server/api.ts:4");
  });

  it("is identical to buildPackPrompt when violations list is empty", () => {
    const base = buildPackPrompt(mockPack(), "Q");
    const withEmpty = buildPackPolicyPrompt(mockPack(), [], "Q");
    expect(withEmpty).toBe(base);
  });
});
