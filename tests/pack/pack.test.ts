import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir, createNestedFile, makeValidContext } from "../helpers.js";
import { writeContext } from "../../src/core/writer.js";
import { buildPack } from "../../src/pack/pack.js";
import { formatPackJson, formatPackMarkdown } from "../../src/pack/format.js";
import { buildBM25 } from "../../src/pack/bm25.js";
import { tokenize } from "../../src/pack/tokenize.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

async function seedThreeScopes(): Promise<void> {
  await mkdir(join(tmpDir, "src/core"), { recursive: true });
  await mkdir(join(tmpDir, "src/commands"), { recursive: true });
  await createNestedFile(tmpDir, "src/core/math.ts", "export const x = 1;\n");
  await createNestedFile(tmpDir, "src/commands/pack.ts", "export const y = 2;\n");
  await createNestedFile(tmpDir, "src/commands/regen.ts", "export const z = 3;\n");

  await writeContext(
    tmpDir,
    makeValidContext({
      scope: ".",
      summary: "Top-level autocontext project — generates folder-level LLM routing YAML.",
      project: { name: "test", description: "demo", language: "ts" },
    }),
  );
  await writeContext(
    join(tmpDir, "src"),
    makeValidContext({
      scope: "src",
      summary: "Source tree holding core + commands.",
    }),
  );
  await writeContext(
    join(tmpDir, "src/core"),
    makeValidContext({
      scope: "src/core",
      summary: "Fingerprinting and semantic staleness utilities.",
      exports: ["computeFingerprint", "computeSemanticFingerprint", "checkFreshness"],
      decisions: [
        { what: "Split cosmetic vs semantic freshness", why: "Pre-commit hook noise" },
      ],
    }),
  );
  await writeContext(
    join(tmpDir, "src/commands"),
    makeValidContext({
      scope: "src/commands",
      summary: "CLI command handlers — pack, regen, status, etc.",
      exports: ["packCommand", "regenCommand", "statusCommand"],
    }),
  );
}

describe("tokenize", () => {
  it("splits camelCase + snake_case and lowercases", () => {
    expect(tokenize("computeFingerprint", "symbols")).toEqual([
      "computefingerprint",
      "compute",
      "fingerprint",
    ]);
    expect(tokenize("compute_file_hash", "symbols")).toEqual([
      "compute_file_hash",
      "compute",
      "file",
      "hash",
    ]);
  });

  it("drops stopwords in non-symbol zones but keeps them in symbols", () => {
    expect(tokenize("the quick brown fox is fast", "summary")).toEqual([
      "quick",
      "brown",
      "fox",
      "fast",
    ]);
    expect(tokenize("is running", "symbols")).toEqual(["is", "running"]);
  });
});

describe("buildBM25", () => {
  it("produces deterministic scoring with a stable tiebreak", async () => {
    await seedThreeScopes();
    const { loadCorpus } = await import("../../src/pack/corpus.js");
    const corpus = await loadCorpus(tmpDir);
    const bm25 = buildBM25(corpus);
    const r1 = bm25.scores(tokenize("fingerprint", "summary"));
    const r2 = bm25.scores(tokenize("fingerprint", "summary"));
    expect(r1).toEqual(r2);
  });
});

describe("buildPack — query seed", () => {
  it("ranks the most relevant scope first and fits the budget", async () => {
    await seedThreeScopes();
    const pack = await buildPack({
      projectRoot: tmpDir,
      query: "fingerprint freshness",
      budget: 2000,
    });
    expect(pack.root?.scope).toBe(".");
    const topScope = pack.scopes[0]?.scope;
    expect(topScope).toBe("src/core");
    expect(pack.used_tokens).toBeLessThanOrEqual(pack.budget + 50);
    expect(pack.metadata.n_scopes_considered).toBeGreaterThanOrEqual(4);
  });

  it("is deterministic across consecutive runs", async () => {
    await seedThreeScopes();
    const a = await buildPack({ projectRoot: tmpDir, query: "CLI commands", budget: 3000 });
    const b = await buildPack({ projectRoot: tmpDir, query: "CLI commands", budget: 3000 });
    expect(formatPackJson(a)).toBe(formatPackJson(b));
    expect(formatPackMarkdown(a)).toBe(formatPackMarkdown(b));
  });
});

describe("buildPack — symbol seed", () => {
  it("pulls in the scope that exports the symbol", async () => {
    await seedThreeScopes();
    const pack = await buildPack({
      projectRoot: tmpDir,
      symbol: "computeFingerprint",
      budget: 2000,
    });
    const scopes = pack.scopes.map((s) => s.scope);
    expect(scopes).toContain("src/core");
    // must-include bias: src/core should rank ahead of unrelated scopes.
    expect(pack.scopes[0]?.scope).toBe("src/core");
  });
});

describe("buildPack — file seed", () => {
  it("anchors on the nearest .context.yaml scope", async () => {
    await seedThreeScopes();
    const pack = await buildPack({
      projectRoot: tmpDir,
      file: "src/commands/pack.ts",
      budget: 2000,
    });
    const scopes = pack.scopes.map((s) => s.scope);
    expect(scopes).toContain("src/commands");
  });
});

describe("formatPackMarkdown", () => {
  it("emits the expected section delimiters", async () => {
    await seedThreeScopes();
    const pack = await buildPack({
      projectRoot: tmpDir,
      query: "fingerprint",
      budget: 3000,
    });
    const md = formatPackMarkdown(pack);
    expect(md).toContain("<!-- autocontext:pack:meta -->");
    expect(md).toContain("<!-- autocontext:section:root -->");
    expect(md).toContain("<!-- autocontext:section:scopes -->");
  });
});
