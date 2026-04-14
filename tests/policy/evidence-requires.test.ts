import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateEvidenceRequires } from "../../src/policy/evaluators/evidence-requires.js";
import type { EvalContext } from "../../src/policy/types.js";
import type { ContextFile } from "../../src/core/schema.js";

function mkContext(overrides: Partial<ContextFile>): ContextFile {
  return {
    version: 1,
    last_updated: "2026-04-13T00:00:00Z",
    fingerprint: "aaaa1111",
    scope: ".",
    summary: "x",
    maintenance: "Keep updated",
    ...overrides,
  } as ContextFile;
}

function ctx(contexts: Map<string, ContextFile>): EvalContext {
  return {
    projectRoot: "/test",
    index: createMemoryIndexStore(),
    contexts,
    sourceFiles: [],
    fileLineCount: async () => 0,
  };
}

describe("evidence_requires evaluator", () => {
  it("flags scopes without evidence when a requirement is set", async () => {
    const contexts = new Map<string, ContextFile>([
      [".", mkContext({ scope: "." })],
    ]);
    const v = await evaluateEvidenceRequires({
      rule: { kind: "evidence_requires", typecheck: "clean" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(contexts),
    });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("no evidence block");
  });

  it("flags scopes whose evidence misses the requirement", async () => {
    const contexts = new Map<string, ContextFile>([
      [".", mkContext({
        scope: ".",
        evidence: {
          collected_at: "2026-04-13T00:00:00Z",
          typecheck: "errors",
          coverage_percent: 72,
        },
      })],
    ]);
    const v = await evaluateEvidenceRequires({
      rule: { kind: "evidence_requires", typecheck: "clean", coverage_min: 80 },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(contexts),
    });
    // typecheck fails, coverage fails
    expect(v).toHaveLength(2);
    const fields = v.map((x) => x.message);
    expect(fields.some((m) => m.includes("typecheck"))).toBe(true);
    expect(fields.some((m) => m.includes("coverage_min"))).toBe(true);
  });

  it("passes when evidence satisfies every requirement", async () => {
    const contexts = new Map<string, ContextFile>([
      [".", mkContext({
        scope: ".",
        evidence: {
          collected_at: "2026-04-13T00:00:00Z",
          test_status: "passing",
          typecheck: "clean",
          coverage_percent: 95,
        },
      })],
    ]);
    const v = await evaluateEvidenceRequires({
      rule: {
        kind: "evidence_requires",
        test_status: "passing",
        typecheck: "clean",
        coverage_min: 80,
      },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(contexts),
    });
    expect(v).toEqual([]);
  });
});
