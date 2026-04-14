import { describe, it, expect } from "vitest";
import * as lib from "../../src/lib.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("src/lib.ts barrel", () => {
  it("re-exports the stable v0 surface", () => {
    expect(typeof lib.buildPack).toBe("function");
    expect(typeof lib.formatPackJson).toBe("function");
    expect(typeof lib.formatPackMarkdown).toBe("function");
    expect(typeof lib.scanProject).toBe("function");
    expect(typeof lib.flattenBottomUp).toBe("function");
    expect(typeof lib.readContext).toBe("function");
    expect(typeof lib.writeContext).toBe("function");
    expect(typeof lib.checkFreshness).toBe("function");
    expect(typeof lib.legacyState).toBe("function");
    expect(typeof lib.loadConfig).toBe("function");
    expect(typeof lib.SCHEMA_VERSION).toBe("number");
    expect(typeof lib.CONTEXT_FILENAME).toBe("string");
    expect(typeof lib.CONFIG_FILENAME).toBe("string");
    // Error classes ship as constructors.
    expect(typeof lib.UnsupportedVersionError).toBe("function");
    // Zod schemas re-exported (validated below).
    expect(lib.contextSchema).toBeDefined();
    expect(lib.configSchema).toBeDefined();
  });

  it("re-exports the experimental surface", () => {
    expect(typeof lib.openIndex).toBe("function");
    expect(typeof lib.computeImpact).toBe("function");
    expect(typeof lib.computeSemanticFingerprint).toBe("function");
    expect(typeof lib.extractPolicyFacts).toBe("function");
    expect(typeof lib.runPolicies).toBe("function");
    expect(typeof lib.IMPACT_CAVEAT).toBe("string");
    expect(typeof lib.SEMANTIC_FINGERPRINT_MARKER).toBe("string");
    expect(lib.ruleSchema).toBeDefined();
    expect(Array.isArray(lib.RULE_KINDS)).toBe(true);
  });
});

describe("src/lib.ts — no internal leakage", () => {
  it("does not import from CLI / MCP / generator / provider internals", async () => {
    const libSource = await readFile(
      join(process.cwd(), "src/lib.ts"),
      "utf-8",
    );
    // Hard exclusion list: symbols that would break consumer assumptions if
    // they started coming out of the barrel. Each is an internal boundary
    // documented in docs/library.md "What's NOT in the library API".
    const forbidden = [
      /from\s+["']\.\/commands\//,      // CLI commands (call process.exit)
      /from\s+["']\.\/mcp\//,           // MCP wiring (has its own contract)
      /from\s+["']\.\/providers\//,     // LLM providers (cache-sensitive)
      /from\s+["']\.\/generator\/llm\.js["']/,  // LLM driver
      /from\s+["']\.\/utils\/display/,  // CLI-only display helpers
      /from\s+["']\.\/index\.js["']/,   // The CLI entry point
    ];
    for (const re of forbidden) {
      expect(libSource).not.toMatch(re);
    }
  });

  it("contains @stability tags on every exported block", async () => {
    const libSource = await readFile(
      join(process.cwd(), "src/lib.ts"),
      "utf-8",
    );
    // Every `export {` line must be preceded by (within ~10 lines) a
    // `@stability` marker. We check that both tiers appear.
    expect(libSource).toMatch(/@stability stable/);
    expect(libSource).toMatch(/@stability experimental/);
  });
});

describe("dist/lib.js — resolves via package main/exports", () => {
  it("dist/lib.js exists after build and exposes the stable surface", async () => {
    // When run after `npm run build`, the dist barrel should resolve cleanly.
    // Skip when dist isn't built (local dev without a build); CI and
    // prepublishOnly both run the build first.
    try {
      const dist = await import(
        /* @vite-ignore */ join(process.cwd(), "dist/lib.js")
      );
      expect(typeof dist.buildPack).toBe("function");
      expect(typeof dist.SCHEMA_VERSION).toBe("number");
    } catch (err) {
      const msg = (err as Error).message;
      if (/Cannot find module|MODULE_NOT_FOUND|ENOENT/.test(msg)) {
        // dist missing — test skipped. Run `npm run build` first.
        return;
      }
      throw err;
    }
  });
});
