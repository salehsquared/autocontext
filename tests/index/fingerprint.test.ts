import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import {
  computeFileFingerprint,
  fileIsStable,
} from "../../src/index/fingerprint.js";

let root: string;

beforeEach(async () => {
  root = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(root);
});

describe("computeFileFingerprint", () => {
  it("returns a 16-char hex content hash", async () => {
    const p = join(root, "a.ts");
    await writeFile(p, "hello");
    const fp = await computeFileFingerprint(p, "a.ts");
    expect(fp.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.file).toBe("a.ts");
    expect(fp.size).toBe(5);
    expect(fp.indexer_version).toMatch(/^t1a\.v\d+$/);
  });

  it("changes the hash when content changes", async () => {
    const p = join(root, "a.ts");
    await writeFile(p, "hello");
    const fp1 = await computeFileFingerprint(p, "a.ts");
    await writeFile(p, "hello world");
    const fp2 = await computeFileFingerprint(p, "a.ts");
    expect(fp1.content_hash).not.toBe(fp2.content_hash);
  });
});

describe("fileIsStable", () => {
  it("returns true when mtime+size match the stored fingerprint", async () => {
    const p = join(root, "a.ts");
    await writeFile(p, "hello");
    const fp = await computeFileFingerprint(p, "a.ts");
    expect(await fileIsStable(p, fp)).toBe(true);
  });

  it("returns false when the file size changes", async () => {
    const p = join(root, "a.ts");
    await writeFile(p, "hello");
    const fp = await computeFileFingerprint(p, "a.ts");
    await writeFile(p, "hello world");
    expect(await fileIsStable(p, fp)).toBe(false);
  });

  it("returns false when the file mtime moves but size holds", async () => {
    const p = join(root, "a.ts");
    await writeFile(p, "hello");
    const fp = await computeFileFingerprint(p, "a.ts");
    const future = new Date(Date.now() + 60_000);
    await utimes(p, future, future);
    expect(await fileIsStable(p, fp)).toBe(false);
  });

  it("returns false when the file is gone", async () => {
    const fp = {
      file: "nope.ts",
      mtime_ms: 1,
      size: 1,
      content_hash: "0".repeat(16),
      indexer_version: "t1a.v1",
    };
    expect(await fileIsStable(join(root, "nope.ts"), fp)).toBe(false);
  });
});
