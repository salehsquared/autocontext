import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.js";
import {
  checkFreshness,
  computeFingerprint,
  legacyState,
  type FreshnessState,
} from "../src/core/fingerprint.js";
import { openIndex } from "../src/index/store.js";
import { buildIndex, commitBuild } from "../src/index/builder.js";
import { computeSemanticFingerprint } from "../src/core/semantic-fingerprint.js";

let root: string;
let srcDir: string;

beforeEach(async () => {
  root = await createTmpDir();
  srcDir = join(root, "src");
  await mkdir(srcDir, { recursive: true });
});

afterEach(async () => {
  await cleanupTmpDir(root);
});

async function indexAll(): Promise<Awaited<ReturnType<typeof openIndex>>> {
  const store = await openIndex(root);
  const result = await buildIndex(root, ["src/a.ts"]);
  await commitBuild(store, result);
  return store;
}

describe("legacyState", () => {
  it.each<[FreshnessState, "fresh" | "stale" | "missing"]>([
    ["fresh", "fresh"],
    ["cosmetic_stale", "stale"],
    ["semantic_stale", "stale"],
    ["missing", "missing"],
  ])("collapses %s to %s", (input, expected) => {
    expect(legacyState(input)).toBe(expected);
  });
});

describe("checkFreshness — 4-state decision matrix", () => {
  async function write(body: string): Promise<void> {
    await writeFile(join(srcDir, "a.ts"), body);
  }

  it("returns missing when no stored fingerprint is provided", async () => {
    await write("export const x = 1;\n");
    const { state } = await checkFreshness(srcDir, undefined);
    expect(state).toBe("missing");
  });

  it("returns fresh when disk fingerprint matches stored", async () => {
    await write("export const x = 1;\n");
    const stored = await computeFingerprint(srcDir);
    const { state } = await checkFreshness(srcDir, stored);
    expect(state).toBe("fresh");
  });

  it("returns cosmetic_stale on disk mismatch with no stored semantic fp (legacy yaml)", async () => {
    await write("export const x = 1;\n");
    const { state } = await checkFreshness(srcDir, "not-the-hash");
    expect(state).toBe("cosmetic_stale");
  });

  it("returns cosmetic_stale when disk differs but semantic fp matches", async () => {
    await write("export function add(a: number, b: number): number { return a + b; }\n");
    const store = await indexAll();
    try {
      const { sem_fp_12 } = await computeSemanticFingerprint(srcDir, {}, store, root);

      // Change the file — whitespace only — so disk fingerprint moves but sem_fp stays.
      await new Promise((r) => setTimeout(r, 20));
      await write("export function add(a: number,   b: number): number { return a + b; }\n");

      // Re-index so the semantic fingerprint above reads the new file state.
      const result = await buildIndex(root, ["src/a.ts"]);
      await commitBuild(store, result);

      const { state } = await checkFreshness(srcDir, "not-the-hash", [], {
        storedSemanticFingerprint: sem_fp_12,
        index: store,
        projectRoot: root,
      });
      expect(state).toBe("cosmetic_stale");
    } finally {
      await store.close();
    }
  });

  it("returns semantic_stale when disk and semantic fingerprints both differ", async () => {
    await write("export function add(a: number, b: number): number { return a + b; }\n");
    const store = await indexAll();
    try {
      const { sem_fp_12 } = await computeSemanticFingerprint(srcDir, {}, store, root);

      // Change the exported signature — semantic change.
      await new Promise((r) => setTimeout(r, 20));
      await write("export function add(a: number, b: number, c: number): number { return a + b + c; }\n");
      const result = await buildIndex(root, ["src/a.ts"]);
      await commitBuild(store, result);

      const { state, computedSemantic } = await checkFreshness(srcDir, "old-hash", [], {
        storedSemanticFingerprint: sem_fp_12,
        index: store,
        projectRoot: root,
      });
      expect(state).toBe("semantic_stale");
      expect(computedSemantic).toBeDefined();
      expect(computedSemantic).not.toBe(sem_fp_12);
    } finally {
      await store.close();
    }
  });

  it("legacy yaml never returns semantic_stale even if index is available", async () => {
    await write("export function add(a: number, b: number): number { return a + b; }\n");
    const store = await indexAll();
    try {
      // No `storedSemanticFingerprint` → legacy yaml path.
      const { state } = await checkFreshness(srcDir, "old-hash", [], {
        index: store,
        projectRoot: root,
      });
      expect(state).toBe("cosmetic_stale");
    } finally {
      await store.close();
    }
  });

  it("returns cosmetic_stale when index is missing, even with a stored semantic fp", async () => {
    await write("export const x = 1;\n");
    const { state } = await checkFreshness(srcDir, "old-hash", [], {
      storedSemanticFingerprint: "aaaaaaaaaaaa",
      // no index provided
      projectRoot: root,
    });
    expect(state).toBe("cosmetic_stale");
  });
});
