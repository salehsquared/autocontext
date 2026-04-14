import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateRequireTestFile } from "../../src/policy/evaluators/require-test-file.js";
import type { EvalContext } from "../../src/policy/types.js";

function ctxWith(files: string[]): EvalContext {
  return {
    projectRoot: "/test",
    index: createMemoryIndexStore(),
    contexts: new Map(),
    sourceFiles: files,
    fileLineCount: async () => 0,
  };
}

describe("require_test_file evaluator", () => {
  it("flags sources without a sibling test file", async () => {
    const v = await evaluateRequireTestFile({
      rule: { kind: "require_test_file", for: "src/**/*.ts", pattern: "{name}.test.{ext}" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctxWith(["src/a.ts", "src/a.test.ts", "src/b.ts"]),
    });
    expect(v.map((x) => x.file)).toEqual(["src/b.ts"]);
  });

  it("accepts tests in non-colocated directories", async () => {
    const v = await evaluateRequireTestFile({
      rule: { kind: "require_test_file", for: "src/**/*.ts", pattern: "{name}.test.{ext}" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctxWith(["src/api.ts", "tests/api.test.ts"]),
    });
    expect(v).toEqual([]);
  });

  it("skips files that match the pattern themselves", async () => {
    const v = await evaluateRequireTestFile({
      rule: { kind: "require_test_file", for: "src/**/*.ts", pattern: "{name}.test.{ext}" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctxWith(["src/a.test.ts"]),
    });
    expect(v).toEqual([]);
  });
});
