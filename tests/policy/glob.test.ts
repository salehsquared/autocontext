import { describe, it, expect } from "vitest";
import { compileGlob, matchGlob } from "../../src/policy/glob.js";

describe("compileGlob / matchGlob", () => {
  it("matches single-segment * ", () => {
    const g = compileGlob("src/*.ts");
    expect(matchGlob("src/a.ts", g)).toBe(true);
    expect(matchGlob("src/a/b.ts", g)).toBe(false);
  });

  it("matches ** across segments", () => {
    const g = compileGlob("src/**/foo.ts");
    expect(matchGlob("src/foo.ts", g)).toBe(true);
    expect(matchGlob("src/a/foo.ts", g)).toBe(true);
    expect(matchGlob("src/a/b/foo.ts", g)).toBe(true);
    expect(matchGlob("lib/foo.ts", g)).toBe(false);
  });

  it("matches ? within a segment", () => {
    const g = compileGlob("a?c.ts");
    expect(matchGlob("abc.ts", g)).toBe(true);
    expect(matchGlob("a/c.ts", g)).toBe(false);
  });

  it("brace-expands", () => {
    const g = compileGlob("src/*.{ts,tsx}");
    expect(matchGlob("src/a.ts", g)).toBe(true);
    expect(matchGlob("src/a.tsx", g)).toBe(true);
    expect(matchGlob("src/a.js", g)).toBe(false);
  });

  it("negates inside array form (last-match-wins)", () => {
    const g = compileGlob(["src/**", "!src/lib/**"]);
    expect(matchGlob("src/core/a.ts", g)).toBe(true);
    expect(matchGlob("src/lib/a.ts", g)).toBe(false);
    expect(matchGlob("src/lib/deep/a.ts", g)).toBe(false);
  });

  it("never matches when all entries are negated", () => {
    const g = compileGlob(["!src/**"]);
    expect(matchGlob("src/a.ts", g)).toBe(false);
  });

  it("handles node: specifiers as literal colons", () => {
    expect(matchGlob("node:fs", compileGlob("node:fs"))).toBe(true);
    expect(matchGlob("node:fs/promises", compileGlob("node:**"))).toBe(true);
  });
});
