import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import {
  ensureAutocontextGitignored,
  hasAutocontextEntry,
} from "../../src/core/gitignore.js";

let root: string;

beforeEach(async () => {
  root = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(root);
});

describe("hasAutocontextEntry", () => {
  it.each([
    ".autocontext",
    ".autocontext/",
    "/.autocontext",
    "/.autocontext/",
    "\n.autocontext/\n",
    "node_modules/\n.autocontext/\ndist/\n",
  ])("recognizes %j", (input) => {
    expect(hasAutocontextEntry(input)).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    expect(hasAutocontextEntry("# .autocontext/\n\n# comment\n")).toBe(false);
  });

  it("does not match prefixes like .autocontext-foo", () => {
    expect(hasAutocontextEntry(".autocontext-foo/\n")).toBe(false);
  });
});

describe("ensureAutocontextGitignored", () => {
  it("does nothing when .gitignore is missing", async () => {
    const result = await ensureAutocontextGitignored(root);
    expect(result.action).toBe("no-gitignore");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("appends when entry is absent and preserves a trailing newline", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
    const result = await ensureAutocontextGitignored(root);
    expect(result.action).toBe("appended");

    const raw = await readFile(join(root, ".gitignore"), "utf8");
    expect(raw).toBe("node_modules/\ndist/\n.autocontext/\n");
  });

  it("adds a leading newline when the file lacks one", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/");
    await ensureAutocontextGitignored(root);
    const raw = await readFile(join(root, ".gitignore"), "utf8");
    expect(raw).toBe("node_modules/\n.autocontext/\n");
  });

  it("is a no-op when the entry already exists", async () => {
    const before = "node_modules/\n.autocontext/\ndist/\n";
    await writeFile(join(root, ".gitignore"), before);
    const result = await ensureAutocontextGitignored(root);
    expect(result.action).toBe("already-present");
    const after = await readFile(join(root, ".gitignore"), "utf8");
    expect(after).toBe(before);
  });

  it("is idempotent across repeated calls", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await ensureAutocontextGitignored(root);
    await ensureAutocontextGitignored(root);
    await ensureAutocontextGitignored(root);
    const raw = await readFile(join(root, ".gitignore"), "utf8");
    const occurrences = raw.split("\n").filter((l) => l.trim() === ".autocontext/").length;
    expect(occurrences).toBe(1);
  });
});
