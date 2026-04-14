import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateRequireImport } from "../../src/policy/evaluators/require-import.js";
import type { EvalContext } from "../../src/policy/types.js";

function ctx(
  store: ReturnType<typeof createMemoryIndexStore>,
  files: string[],
): EvalContext {
  return {
    projectRoot: "/test",
    index: store,
    contexts: new Map(),
    sourceFiles: files,
    fileLineCount: async () => 0,
  };
}

describe("require_import evaluator", () => {
  it("flags files missing the required import", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/api/a.ts", raw: "./schema", resolved_to: "src/api/schema.ts", symbols: [], kind: "static", line: 1 },
      ],
    });
    const violations = await evaluateRequireImport({
      rule: { kind: "require_import", from: "src/api/**", to: "src/api/schema.ts" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(index, ["src/api/a.ts", "src/api/b.ts"]),
    });
    expect(violations.map((v) => v.file)).toEqual(["src/api/b.ts"]);
  });

  it("passes when every matching file has a matching import", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/api/a.ts", raw: "./schema", resolved_to: "src/api/schema.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/api/b.ts", raw: "./schema", resolved_to: "src/api/schema.ts", symbols: [], kind: "static", line: 1 },
      ],
    });
    const violations = await evaluateRequireImport({
      rule: { kind: "require_import", from: "src/api/**", to: "src/api/schema.ts" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: ctx(index, ["src/api/a.ts", "src/api/b.ts"]),
    });
    expect(violations).toEqual([]);
  });
});
