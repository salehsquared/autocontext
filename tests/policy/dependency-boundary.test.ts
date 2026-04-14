import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateDependencyBoundary } from "../../src/policy/evaluators/dependency-boundary.js";
import type { EvalContext } from "../../src/policy/types.js";

function ctx(store: ReturnType<typeof createMemoryIndexStore>): EvalContext {
  return {
    projectRoot: "/test",
    index: store,
    contexts: new Map(),
    sourceFiles: [],
    fileLineCount: async () => 0,
  };
}

describe("dependency_boundary evaluator", () => {
  it("flags imports outside allowed_to", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/policy/engine.ts", raw: "../index/store", resolved_to: "src/index/store.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/policy/engine.ts", raw: "../mcp/tools", resolved_to: "src/mcp/tools.ts", symbols: [], kind: "static", line: 2 },
      ],
    });
    const v = await evaluateDependencyBoundary({
      rule: { kind: "dependency_boundary", from: "src/policy/**", allowed_to: ["src/index/**", "src/core/**"] },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(index),
    });
    expect(v.map((x) => x.to)).toEqual(["src/mcp/tools.ts"]);
  });
});
