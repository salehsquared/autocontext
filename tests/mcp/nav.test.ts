import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createTmpDir,
  cleanupTmpDir,
  createNestedFile,
  makeValidContext,
} from "../helpers.js";
import { writeContext } from "../../src/core/writer.js";
import {
  handleFindDefinition,
  handleFindReferences,
  handleFindRelated,
  handleSearchContext,
  handleImpact,
  REFERENCES_CAVEAT,
} from "../../src/mcp/nav.js";
import {
  TOOL_SINCE_VERSION,
  buildCapabilityResource,
  SERVER_VERSION,
  TOOLS_VERSION,
} from "../../src/mcp/capabilities.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

async function seedCorpus(): Promise<void> {
  await mkdir(join(tmpDir, "src/core"), { recursive: true });
  await createNestedFile(tmpDir, "src/core/math.ts", "export const x = 1;\n");
  await writeContext(
    tmpDir,
    makeValidContext({
      scope: ".",
      summary: "Root context for the nav test fixture.",
      project: { name: "nav", description: "nav fixture", language: "ts" },
    }),
  );
  await writeContext(
    join(tmpDir, "src/core"),
    makeValidContext({
      scope: "src/core",
      summary: "Fingerprinting and staleness.",
      exports: ["computeFingerprint", "checkFreshness"],
    }),
  );
}

describe("nav handlers — INDEX_MISSING path", () => {
  it("find_definition returns INDEX_MISSING when no index", async () => {
    await seedCorpus();
    const res = await handleFindDefinition({ symbol: "computeFingerprint" }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INDEX_MISSING");
    expect(res.error?.remediation).toContain("context index");
  });

  it("find_references returns INDEX_MISSING when no index", async () => {
    await seedCorpus();
    const res = await handleFindReferences({ symbol: "anything" }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INDEX_MISSING");
    // Caveat pinned even on error envelope construction.
    expect(res.reference_kind).toBe("import_bound");
    expect(res.caveat).toBe(REFERENCES_CAVEAT);
  });

  it("find_related returns INDEX_MISSING when no index", async () => {
    await seedCorpus();
    const res = await handleFindRelated({ seed: { file: "src/core/math.ts" } }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INDEX_MISSING");
  });

  it("impact returns INDEX_MISSING when no index", async () => {
    await seedCorpus();
    const res = await handleImpact({ seed: "src/core/math.ts" }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INDEX_MISSING");
  });
});

describe("find_references — invalid input validation", () => {
  it("rejects when neither symbol nor symbol_id supplied", async () => {
    const res = await handleFindReferences({}, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects when both symbol and symbol_id supplied", async () => {
    const res = await handleFindReferences({ symbol: "x", symbol_id: "y" }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_INPUT");
  });
});

describe("find_related — invalid input validation", () => {
  it("rejects when neither seed.file nor seed.symbol supplied", async () => {
    const res = await handleFindRelated({ seed: {} }, tmpDir);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_INPUT");
  });
});

describe("search_context — works without the code index", () => {
  it("returns ranked scopes for a matching query", async () => {
    await seedCorpus();
    const res = await handleSearchContext(
      { query: "fingerprint staleness", limit: 5 },
      tmpDir,
    );
    expect(res.ok).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
    // src/core should rank above the root for a semantic/symbol-rich query.
    expect(res.results[0].scope).toBe("src/core");
    expect(res.results[0].matches.length).toBeGreaterThan(0);
  });

  it("returns deterministic scores across runs", async () => {
    await seedCorpus();
    const a = await handleSearchContext({ query: "fingerprint" }, tmpDir);
    const b = await handleSearchContext({ query: "fingerprint" }, tmpDir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns empty results on an empty project", async () => {
    const res = await handleSearchContext({ query: "nothing" }, tmpDir);
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([]);
  });

  it("restricts zones when fields is set", async () => {
    await seedCorpus();
    // 'computeFingerprint' only lives in the symbols zone. Searching the
    // 'path' zone alone should drop src/core (path tokens don't contain the
    // symbol name).
    const pathOnly = await handleSearchContext(
      { query: "computeFingerprint", fields: ["path"] },
      tmpDir,
    );
    expect(pathOnly.results.every((r) => r.scope !== "src/core")).toBe(true);
  });
});

describe("capabilities resource", () => {
  it("lists all 12 tools with since metadata", () => {
    const names = Object.keys(TOOL_SINCE_VERSION);
    expect(names).toHaveLength(12);
    expect(names).toContain("find_definition");
    expect(names).toContain("impact");
  });

  it("buildCapabilityResource shape matches the constants", () => {
    const res = buildCapabilityResource();
    expect(res.server_version).toBe(SERVER_VERSION);
    expect(res.tools_version).toBe(TOOLS_VERSION);
    expect(res.tools).toHaveLength(12);
    expect(res.index.required_by).toContain("find_definition");
    expect(res.bm25.required_by).toContain("search_context");
    expect(res.compat.legacy_state_tools).toContain("check_freshness");
    expect(res.compat.new_state_tools).toContain("explain_staleness");
  });
});
