import { describe, it, expect } from "vitest";
import { createMemoryIndexStore } from "../helpers/memory-index-store.js";
import { generateSymbolTasks } from "../../src/bench/ground-truth-symbols.js";
import type { IndexSymbol } from "../../src/index/types.js";

function sym(overrides: Partial<IndexSymbol> & Pick<IndexSymbol, "name" | "file" | "exported">): IndexSymbol {
  return {
    id: `${overrides.file}#${overrides.name}@0`,
    kind: "function",
    span: { startLine: 1, endLine: 1, nameByteOffset: 0 },
    lang: "ts",
    ...overrides,
  };
}

describe("generateSymbolTasks (ground truth)", () => {
  it("emits one find-definition task per uniquely-named exported symbol", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/a.ts", raw: "./b", resolved_to: "src/b.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/c.ts", raw: "./b", resolved_to: "src/b.ts", symbols: [], kind: "static", line: 1 },
      ],
      symbols: [
        sym({ name: "alpha", file: "src/a.ts", exported: true }),
        sym({ name: "beta", file: "src/b.ts", exported: true }),
        sym({ name: "gamma", file: "src/c.ts", exported: true }),
        // A duplicate name — must be excluded.
        sym({ name: "dup", file: "src/a.ts", exported: true }),
        sym({ name: "dup", file: "src/c.ts", exported: true }),
        // Non-exported — must be excluded.
        sym({ name: "local", file: "src/a.ts", exported: false }),
      ],
    });
    const { findDefinitionTasks } = await generateSymbolTasks({
      index,
      indexVersion: 1,
      maxDefinitionTasks: 10,
      seed: 42,
    });
    const names = findDefinitionTasks.map((t) => t.expected[0]).sort();
    expect(names).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    for (const t of findDefinitionTasks) {
      expect(t.category).toBe("find-definition");
      expect(t.scoring).toBe("target_hit");
      expect(t.ground_truth_provenance?.source).toBe("t1_symbols");
      expect(t.ground_truth_provenance?.precision_class).toBe("authoritative");
    }
  });

  it("excludes .d.ts declarations from find-definition", async () => {
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/a.ts", raw: "./types", resolved_to: "src/types.d.ts", symbols: [], kind: "static", line: 1 },
      ],
      symbols: [
        sym({ name: "UserType", file: "src/types.d.ts", exported: true }),
        sym({ name: "realFn", file: "src/a.ts", exported: true }),
      ],
    });
    const { findDefinitionTasks } = await generateSymbolTasks({
      index,
      indexVersion: 1,
      maxDefinitionTasks: 10,
      seed: 42,
    });
    const names = findDefinitionTasks.map((t) => t.expected[0]).sort();
    expect(names).not.toContain("src/types.d.ts");
    expect(names).toContain("src/a.ts");
  });

  it("find-callers requires 2-20 referring files per symbol", async () => {
    const refs = [
      { symbol_id: "src/b.ts#target@0", file: "src/a.ts", span: { startLine: 1, endLine: 1, nameByteOffset: 0 }, via_import: { from: "src/a.ts", raw: "./b" }, kind: "identifier_use" as const },
      { symbol_id: "src/b.ts#target@0", file: "src/c.ts", span: { startLine: 1, endLine: 1, nameByteOffset: 0 }, via_import: { from: "src/c.ts", raw: "./b" }, kind: "identifier_use" as const },
    ];
    const soloRef = [refs[0]];
    const index = createMemoryIndexStore({
      imports: [
        { from: "src/a.ts", raw: "./b", resolved_to: "src/b.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/c.ts", raw: "./b", resolved_to: "src/b.ts", symbols: [], kind: "static", line: 1 },
        { from: "src/a.ts", raw: "./solo", resolved_to: "src/solo.ts", symbols: [], kind: "static", line: 2 },
      ],
      symbols: [
        sym({ name: "target", file: "src/b.ts", exported: true }),
        sym({ name: "orphan", file: "src/solo.ts", exported: true }),
      ],
      references: [...refs, ...soloRef.map((r) => ({ ...r, symbol_id: "src/solo.ts#orphan@0" }))],
    });
    const { findCallersTasks } = await generateSymbolTasks({
      index,
      indexVersion: 1,
      maxCallerTasks: 10,
      seed: 7,
    });
    // `target` has 2 referring files → included; `orphan` has 1 → excluded.
    const names = findCallersTasks.map((t) => t.id);
    expect(names).toContain("find-callers:target");
    expect(names).not.toContain("find-callers:orphan");
    const t = findCallersTasks.find((x) => x.id === "find-callers:target")!;
    expect(t.scoring).toBe("file_set_f1");
    expect(t.expected).toEqual(["src/a.ts", "src/c.ts"]);
    expect(t.ground_truth_provenance?.source).toBe("t1_references");
    expect(t.ground_truth_provenance?.precision_class).toBe("import_bound");
  });
});
