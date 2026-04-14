import { describe, it, expect } from "vitest";
import { createResolverContext, resolveTsImport } from "../../src/index/resolve.js";

const ctx = createResolverContext("/project", [
  "src/math.ts",
  "src/strings.ts",
  "src/nested/index.ts",
  "src/both.ts",
  "src/both.js",
]);

describe("resolveTsImport", () => {
  it("resolves extensionless relative imports by trying TS/JS extensions", () => {
    expect(resolveTsImport("src/a.ts", "./math", ctx)).toBe("src/math.ts");
  });

  it("prefers .ts over .js when both exist", () => {
    expect(resolveTsImport("src/a.ts", "./both", ctx)).toBe("src/both.ts");
  });

  it("resolves directory imports via index.ts", () => {
    expect(resolveTsImport("src/a.ts", "./nested", ctx)).toBe("src/nested/index.ts");
  });

  it("resolves parent-relative imports", () => {
    expect(resolveTsImport("src/nested/x.ts", "../math", ctx)).toBe("src/math.ts");
  });

  it("maps .js specifiers back to their .ts sibling (ESM-style TS imports)", () => {
    expect(resolveTsImport("src/a.ts", "./math.js", ctx)).toBe("src/math.ts");
  });

  it("returns null for bare/external specifiers", () => {
    expect(resolveTsImport("src/a.ts", "lodash", ctx)).toBeNull();
    expect(resolveTsImport("src/a.ts", "@scope/x", ctx)).toBeNull();
  });

  it("returns null when the target does not exist", () => {
    expect(resolveTsImport("src/a.ts", "./missing", ctx)).toBeNull();
  });
});
