import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../../src/index/lock.js";
import { cleanupTmpDir, createTmpDir } from "../helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("index lock", () => {
  it("does not admit an exclusive holder while shared leases remain", async () => {
    const lockPath = join(tmpDir, ".autocontext/index/.lock");
    const handles = await Promise.all(
      Array.from({ length: 12 }, () => acquireLock(lockPath, "shared", 500)),
    );

    await Promise.all(handles.slice(0, 2).map((handle) => handle.release()));

    await expect(acquireLock(lockPath, "exclusive", 100)).rejects.toMatchObject({
      code: "EAUTOCONTEXTLOCKED",
    });

    await Promise.all(handles.slice(2).map((handle) => handle.release()));

    const exclusive = await acquireLock(lockPath, "exclusive", 500);
    await exclusive.release();
  });

  it("cleans stale reader leases before granting an exclusive lock", async () => {
    const lockPath = join(tmpDir, ".autocontext/index/.lock");
    const readersDir = `${lockPath}.readers`;
    await mkdir(readersDir, { recursive: true });
    await writeFile(
      join(readersDir, "stale-reader.json"),
      JSON.stringify({ mode: "shared", pid: 999999, acquired_at: Date.now() }),
      "utf-8",
    );

    const exclusive = await acquireLock(lockPath, "exclusive", 500);
    await exclusive.release();
  });
});
