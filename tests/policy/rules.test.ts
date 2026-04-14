import { describe, it, expect } from "vitest";
import { ruleSchema } from "../../src/policy/rules.js";

describe("ruleSchema", () => {
  it("accepts each rule kind", () => {
    const cases = [
      { kind: "forbid_import", from: "a/**", to: "b/**" },
      { kind: "require_import", from: "a/**", to: "b/**" },
      { kind: "require_export", name: "buildPack", symbol_kind: "function" },
      { kind: "max_file_lines", value: 500 },
      { kind: "require_test_file", for: "src/**/*.ts", pattern: "{name}.test.{ext}" },
      { kind: "dependency_boundary", from: "src/a/**", allowed_to: ["src/b/**"] },
      { kind: "evidence_requires", test_status: "passing", typecheck: "clean", lint_status: "clean", coverage_min: 80 },
    ];
    for (const c of cases) {
      expect(ruleSchema.safeParse(c).success).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    expect(ruleSchema.safeParse({ kind: "explode", from: "x", to: "y" }).success).toBe(false);
  });

  it("typecheck literal must be 'clean' (not 'passing')", () => {
    const bad = ruleSchema.safeParse({ kind: "evidence_requires", typecheck: "passing" });
    expect(bad.success).toBe(false);
  });

  it("rejects extra fields under strict()", () => {
    const bad = ruleSchema.safeParse({ kind: "forbid_import", from: "x", to: "y", oops: true });
    expect(bad.success).toBe(false);
  });

  it("rejects negative max_file_lines.value", () => {
    expect(ruleSchema.safeParse({ kind: "max_file_lines", value: -1 }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "max_file_lines", value: 0 }).success).toBe(false);
  });

  it("rejects empty dependency_boundary.allowed_to", () => {
    expect(ruleSchema.safeParse({ kind: "dependency_boundary", from: "a/**", allowed_to: [] }).success).toBe(false);
  });

  it("accepts `from`/`to` as array", () => {
    expect(ruleSchema.safeParse({ kind: "forbid_import", from: ["a/**", "!a/lib/**"], to: ["x/**"] }).success).toBe(true);
  });
});
