import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { computeFingerprint, checkFreshness } from "../src/core/fingerprint.js";
import { createTmpDir, cleanupTmpDir, createFile } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("computeFingerprint", () => {
  it("returns deterministic hash for same files", async () => {
    await createFile(tmpDir, "a.ts", "const a = 1;");
    await createFile(tmpDir, "b.ts", "const b = 2;");

    const hash1 = await computeFingerprint(tmpDir);
    const hash2 = await computeFingerprint(tmpDir);
    expect(hash1).toBe(hash2);
  });

  it("returns 8-character hex string", async () => {
    await createFile(tmpDir, "a.ts", "hello");
    const hash = await computeFingerprint(tmpDir);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when file size changes", async () => {
    await createFile(tmpDir, "a.ts", "hello");
    const hash1 = await computeFingerprint(tmpDir);

    // Wait to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await createFile(tmpDir, "a.ts", "hello world — bigger now");
    const hash2 = await computeFingerprint(tmpDir);

    expect(hash1).not.toBe(hash2);
  });

  it("excludes .context.yaml from fingerprint", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const hash1 = await computeFingerprint(tmpDir);

    await createFile(tmpDir, ".context.yaml", "version: 1");
    const hash2 = await computeFingerprint(tmpDir);

    expect(hash1).toBe(hash2);
  });

  it("respects ignore patterns - exact match", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const hashWithout = await computeFingerprint(tmpDir);

    await createFile(tmpDir, "debug.log", "log data");
    const hashWith = await computeFingerprint(tmpDir);
    const hashIgnored = await computeFingerprint(tmpDir, ["debug.log"]);

    expect(hashWith).not.toBe(hashWithout);
    expect(hashIgnored).toBe(hashWithout);
  });

  it("respects ignore patterns - glob *.ext", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const hashBase = await computeFingerprint(tmpDir);

    await createFile(tmpDir, "b.log", "log1");
    await createFile(tmpDir, "c.log", "log2");
    const hashIgnored = await computeFingerprint(tmpDir, ["*.log"]);

    expect(hashIgnored).toBe(hashBase);
  });

  it("returns a fingerprint for empty directory", async () => {
    const hash = await computeFingerprint(tmpDir);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("ignores subdirectories (only considers files)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const hash1 = await computeFingerprint(tmpDir);

    await mkdir(join(tmpDir, "subdir"));
    const hash2 = await computeFingerprint(tmpDir);

    expect(hash1).toBe(hash2);
  });
});

describe("computeFingerprint — add/delete file staleness", () => {
  it("adding a new file changes fingerprint", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const hash1 = await computeFingerprint(tmpDir);

    await createFile(tmpDir, "b.ts", "more code");
    const hash2 = await computeFingerprint(tmpDir);

    expect(hash1).not.toBe(hash2);
  });

  it("deleting a file changes fingerprint", async () => {
    await createFile(tmpDir, "a.ts", "code");
    await createFile(tmpDir, "b.ts", "more code");
    const hash1 = await computeFingerprint(tmpDir);

    const { rm } = await import("node:fs/promises");
    await rm(join(tmpDir, "b.ts"));
    const hash2 = await computeFingerprint(tmpDir);

    expect(hash1).not.toBe(hash2);
  });
});

describe("checkFreshness", () => {
  it("returns 'fresh' when fingerprints match", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const fingerprint = await computeFingerprint(tmpDir);

    const result = await checkFreshness(tmpDir, fingerprint);
    expect(result.state).toBe("fresh");
  });

  it("returns 'cosmetic_stale' on legacy yaml (no stored semantic fp) when fingerprints differ", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const oldFingerprint = await computeFingerprint(tmpDir);

    await new Promise((r) => setTimeout(r, 50));
    await createFile(tmpDir, "a.ts", "modified code with different size");

    // No storedSemanticFingerprint option → legacy path → cosmetic_stale, not semantic_stale.
    const result = await checkFreshness(tmpDir, oldFingerprint);
    expect(result.state).toBe("cosmetic_stale");
  });

  it("returns 'missing' when storedFingerprint is undefined", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const result = await checkFreshness(tmpDir, undefined);
    expect(result.state).toBe("missing");
  });

  it("returns the computed fingerprint in all cases", async () => {
    await createFile(tmpDir, "a.ts", "code");

    const fresh = await checkFreshness(tmpDir, await computeFingerprint(tmpDir));
    expect(fresh.computed).toMatch(/^[0-9a-f]{8}$/);

    const missing = await checkFreshness(tmpDir, undefined);
    expect(missing.computed).toMatch(/^[0-9a-f]{8}$/);
  });
});
