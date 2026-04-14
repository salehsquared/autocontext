import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateMaxFileLines } from "../../src/policy/evaluators/max-file-lines.js";
import type { EvalContext } from "../../src/policy/types.js";

function makeCtx(lineMap: Record<string, number>): EvalContext {
  const files = Object.keys(lineMap);
  return {
    projectRoot: "/test",
    index: createMemoryIndexStore(),
    contexts: new Map(),
    sourceFiles: files,
    fileLineCount: async (f) => lineMap[f] ?? 0,
  };
}

describe("max_file_lines evaluator", () => {
  it("flags files strictly over the limit", async () => {
    const v = await evaluateMaxFileLines({
      rule: { kind: "max_file_lines", value: 100 },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: makeCtx({ "a.ts": 99, "b.ts": 100, "c.ts": 101 }),
    });
    expect(v.map((x) => x.file)).toEqual(["c.ts"]);
  });

  it("respects exclude globs", async () => {
    const v = await evaluateMaxFileLines({
      rule: { kind: "max_file_lines", value: 10, exclude: ["**/*.generated.ts"] },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: makeCtx({ "a.ts": 200, "b.generated.ts": 5000 }),
    });
    expect(v.map((x) => x.file)).toEqual(["a.ts"]);
  });
});
