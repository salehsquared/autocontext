import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateForbidImport } from "../../src/policy/evaluators/forbid-import.js";
import type { EvalContext } from "../../src/policy/types.js";

function evalCtx(store: ReturnType<typeof createMemoryIndexStore>): EvalContext {
  return {
    projectRoot: "/test",
    index: store,
    contexts: new Map(),
    sourceFiles: [],
    fileLineCount: async () => 0,
  };
}

describe("forbid_import evaluator", () => {
  it("flags imports matching from+to", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/server/api.ts", raw: "../client/types", resolved_to: "src/client/types.ts", symbols: [], kind: "static", line: 4 },
        { from: "src/server/api.ts", raw: "../core/schema", resolved_to: "src/core/schema.ts", symbols: [], kind: "static", line: 5 },
      ],
    });
    const violations = await evaluateForbidImport({
      rule: { kind: "forbid_import", from: "src/server/**", to: "src/client/**" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: evalCtx(index),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("src/server/api.ts");
    expect(violations[0].to).toBe("src/client/types.ts");
    expect(violations[0].line).toBe(4);
  });

  it("matches raw specifier when resolved_to is null (external)", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/api.ts", raw: "lodash", resolved_to: null, symbols: [], kind: "static", line: 1 },
      ],
    });
    const violations = await evaluateForbidImport({
      rule: { kind: "forbid_import", from: "src/**", to: "lodash" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: evalCtx(index),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].to).toBe("lodash");
  });

  it("respects negated globs in array form", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/server/api.ts", raw: "../client/a", resolved_to: "src/client/a.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/server/api.ts", raw: "../client/types", resolved_to: "src/client/types.ts", symbols: [], kind: "static", line: 2 },
      ],
    });
    const violations = await evaluateForbidImport({
      rule: { kind: "forbid_import", from: "src/server/**", to: ["src/client/**", "!src/client/types.ts"] },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: evalCtx(index),
    });
    expect(violations.map((v) => v.to)).toEqual(["src/client/a.ts"]);
  });

  it("uses rule.message when provided", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/server/api.ts", raw: "../client/t", resolved_to: "src/client/t.ts", symbols: [], kind: "static", line: 7 },
      ],
    });
    const violations = await evaluateForbidImport({
      rule: { kind: "forbid_import", from: "src/server/**", to: "src/client/**", message: "no client imports from server" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: evalCtx(index),
    });
    expect(violations[0].message).toBe("no client imports from server");
  });
});
