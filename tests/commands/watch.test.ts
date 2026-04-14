import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeContext } from "../../src/core/writer.js";
import { computeFingerprint, checkFreshness } from "../../src/core/fingerprint.js";
import { createTmpDir, cleanupTmpDir, createFile, makeValidContext } from "../helpers.js";
import { findTrackedDirForFile } from "../../src/commands/watch.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("watch building blocks", () => {
  it("detects fresh state for up-to-date context", async () => {
    await createFile(tmpDir, "index.ts", "export const x = 1;");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    const { state } = await checkFreshness(tmpDir, fp);
    expect(state).toBe("fresh");
  });

  it("detects stale state after file change", async () => {
    await createFile(tmpDir, "index.ts", "short");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    // Modify a file — fingerprint should now differ
    await createFile(tmpDir, "index.ts", "this is much longer content that changes the size");

    const { state } = await checkFreshness(tmpDir, fp);
    // Legacy yaml (no stored semantic_fingerprint) never reports semantic_stale.
    expect(state).toBe("cosmetic_stale");
  });

  it("reports missing when no fingerprint stored", async () => {
    await createFile(tmpDir, "index.ts", "code");

    const { state } = await checkFreshness(tmpDir, undefined);
    expect(state).toBe("missing");
  });

  it("handles empty directory gracefully", async () => {
    const { state } = await checkFreshness(tmpDir, undefined);
    expect(state).toBe("missing");
  });

  it("finds nearest tracked directory for POSIX paths", () => {
    const tracked = ["/repo", "/repo/src", "/repo/src/core"];
    const match = findTrackedDirForFile("/repo/src/core/index.ts", "/repo", tracked);
    expect(match).toBe("/repo/src/core");
  });

  it("finds nearest tracked directory for Windows-style paths", () => {
    const tracked = ["C:\\repo", "C:\\repo\\src", "C:\\repo\\src\\core"];
    const match = findTrackedDirForFile(
      "C:\\repo\\src\\core\\index.ts",
      "C:\\repo",
      tracked,
    );
    expect(match).toBe("C:/repo/src/core");
  });
});
