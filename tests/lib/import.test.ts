import { describe, it, expect } from "vitest";
import * as lib from "../../src/lib.js";

describe("src/lib.ts barrel", () => {
  it("re-exports the stable v0 surface", () => {
    expect(typeof lib.buildPack).toBe("function");
    expect(typeof lib.scanProject).toBe("function");
    expect(typeof lib.readContext).toBe("function");
    expect(typeof lib.writeContext).toBe("function");
    expect(typeof lib.checkFreshness).toBe("function");
    expect(typeof lib.legacyState).toBe("function");
    expect(typeof lib.loadConfig).toBe("function");
    expect(typeof lib.SCHEMA_VERSION).toBe("number");
  });

  it("re-exports the experimental surface (openIndex, computeImpact)", () => {
    expect(typeof lib.openIndex).toBe("function");
    expect(typeof lib.computeImpact).toBe("function");
    expect(typeof lib.computeSemanticFingerprint).toBe("function");
    expect(typeof lib.IMPACT_CAVEAT).toBe("string");
    expect(typeof lib.SEMANTIC_FINGERPRINT_MARKER).toBe("string");
  });
});
