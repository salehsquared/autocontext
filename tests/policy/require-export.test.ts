import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { evaluateRequireExport } from "../../src/policy/evaluators/require-export.js";
import type { EvalContext } from "../../src/policy/types.js";
import type { IndexSymbol } from "../../src/index/types.js";

const mkSym = (overrides: Partial<IndexSymbol> & Pick<IndexSymbol, "name" | "file">): IndexSymbol => ({
  id: `${overrides.file}#${overrides.name}@0`,
  kind: "function",
  exported: true,
  span: { startLine: 1, endLine: 1, nameByteOffset: 0 },
  lang: "ts",
  ...overrides,
});

function baseCtx(store: ReturnType<typeof createMemoryIndexStore>): EvalContext {
  return {
    projectRoot: "/test",
    index: store,
    contexts: new Map(),
    sourceFiles: [],
    fileLineCount: async () => 0,
  };
}

describe("require_export evaluator", () => {
  it("passes when an exported symbol of any kind exists in scope", async () => {
    const index = createMemoryIndexStore({
      symbols: [mkSym({ name: "buildPack", file: "src/pack/pack.ts" })],
    });
    const v = await evaluateRequireExport({
      rule: { kind: "require_export", name: "buildPack" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: baseCtx(index),
    });
    expect(v).toEqual([]);
  });

  it("fails when missing", async () => {
    const index = createMemoryIndexStore({ symbols: [] });
    const v = await evaluateRequireExport({
      rule: { kind: "require_export", name: "nope" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: baseCtx(index),
    });
    expect(v).toHaveLength(1);
    expect(v[0].symbol).toBe("nope");
  });

  it("fails when symbol_kind does not match", async () => {
    const index = createMemoryIndexStore({
      symbols: [mkSym({ name: "X", file: "src/a.ts", kind: "class" })],
    });
    const v = await evaluateRequireExport({
      rule: { kind: "require_export", name: "X", symbol_kind: "function" },
      ruleScope: ".",
      ruleIndex: 0,
      ctx: baseCtx(index),
    });
    expect(v).toHaveLength(1);
  });

  it("scope subtree limits candidates", async () => {
    const index = createMemoryIndexStore({
      symbols: [mkSym({ name: "Y", file: "src/lib/y.ts" })],
    });
    const v = await evaluateRequireExport({
      rule: { kind: "require_export", name: "Y" },
      ruleScope: "src/api",
      ruleIndex: 0,
      ctx: baseCtx(index),
    });
    expect(v).toHaveLength(1);
  });
});
