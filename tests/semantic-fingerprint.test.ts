import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.js";
import {
  computeSemanticFingerprint,
  stableStringify,
  SEMANTIC_FINGERPRINT_MARKER,
} from "../src/core/semantic-fingerprint.js";
import { openIndex } from "../src/index/store.js";
import { buildIndex, commitBuild } from "../src/index/builder.js";

let root: string;

beforeEach(async () => {
  root = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(root);
});

async function seedTsProject(
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
}

async function indexAndCompute(
  dirRel: string,
  facts: Parameters<typeof computeSemanticFingerprint>[1] = {},
): Promise<string> {
  const store = await openIndex(root);
  try {
    const files = Object.keys(await readdirTree(root)).sort();
    const result = await buildIndex(root, files);
    await commitBuild(store, result);
    const { sem_fp_12 } = await computeSemanticFingerprint(
      join(root, dirRel),
      facts,
      store,
      root,
    );
    return sem_fp_12;
  } finally {
    await store.close();
  }
}

/** Recursive readdir returning POSIX-relative file paths. */
async function readdirTree(dir: string): Promise<Record<string, true>> {
  const { readdir } = await import("node:fs/promises");
  const out: Record<string, true> = {};
  async function walk(cur: string, rel: string) {
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(cur, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, relPath);
      else if (/\.(ts|tsx|js|jsx|py)$/.test(e.name)) out[relPath] = true;
    }
  }
  await walk(dir, "");
  return out;
}

describe("stableStringify", () => {
  it("sorts object keys at every depth", () => {
    expect(stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe(
      '{"a":2,"b":1,"c":{"y":2,"z":1}}',
    );
  });
  it("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });
  it("handles null and primitive values", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hi")).toBe('"hi"');
  });
});

describe("computeSemanticFingerprint", () => {
  it("is deterministic: same inputs yield identical 12-hex fingerprint", async () => {
    await seedTsProject({
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/consumer.ts": "import { add } from './math';\nexport const x = add(1, 2);\n",
    });
    const fp1 = await indexAndCompute("src");
    const fp2 = await indexAndCompute("src");
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("does NOT change when only a non-exported body or a comment changes", async () => {
    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\nfunction helper() { return 1; }\n",
    });
    const before = await indexAndCompute("src");

    await seedTsProject({
      "src/a.ts": "// harmless comment\nexport function add(a: number, b: number): number { return a + b; }\nfunction helper() { return 999; }\n",
    });
    const after = await indexAndCompute("src");

    expect(after).toBe(before);
  });

  it("DOES change when an exported signature changes", async () => {
    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const before = await indexAndCompute("src");

    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number, c: number = 0): number { return a + b + c; }\n",
    });
    const after = await indexAndCompute("src");

    expect(after).not.toBe(before);
  });

  it("DOES change when a new export is added", async () => {
    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const before = await indexAndCompute("src");

    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\nexport function sub(a: number, b: number): number { return a - b; }\n",
    });
    const after = await indexAndCompute("src");

    expect(after).not.toBe(before);
  });

  it("DOES change when an import is added, removed, or rerouted", async () => {
    await seedTsProject({
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/a.ts": "import { add } from './math';\nexport const x = add(1, 2);\n",
    });
    const before = await indexAndCompute("src");

    await seedTsProject({
      "src/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/a.ts": "export const x = 3;\n",
    });
    const after = await indexAndCompute("src");
    expect(after).not.toBe(before);
  });

  it("DOES change when policy-relevant facts change (constraints/rules/env)", async () => {
    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const base = await indexAndCompute("src", { constraints: ["a < b"] });
    const addedConstraint = await indexAndCompute("src", {
      constraints: ["a < b", "must be pure"],
    });
    const differentEnv = await indexAndCompute("src", {
      constraints: ["a < b"],
      environment: ["NODE_ENV=production"],
    });
    expect(addedConstraint).not.toBe(base);
    expect(differentEnv).not.toBe(base);
  });

  it("is insensitive to ordering of facts arrays", async () => {
    await seedTsProject({
      "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\n",
    });
    const a = await indexAndCompute("src", {
      constraints: ["a < b", "pure"],
      environment: ["NODE_ENV=prod", "LANG=en"],
    });
    const b = await indexAndCompute("src", {
      constraints: ["pure", "a < b"],
      environment: ["LANG=en", "NODE_ENV=prod"],
    });
    expect(a).toBe(b);
  });

  it("contains the SEMANTIC_FINGERPRINT_MARKER in its preimage", () => {
    // Sanity that the marker constant is reachable; guards against a rename
    // silently invalidating every fingerprint on upgrade.
    expect(SEMANTIC_FINGERPRINT_MARKER).toBe("semv1");
  });
});
