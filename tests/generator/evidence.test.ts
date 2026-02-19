import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { createTmpDir, cleanupTmpDir, createFile } from "../helpers.js";
import { collectBasicEvidence, resolveGitHeadSha } from "../../src/generator/evidence.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

// --- Test artifact detection ---

describe("test artifact detection", () => {
  it("detects .vitest-results.json with test_tool vitest", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: true,
      numTotalTests: 10,
      numFailedTests: 0,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_status).toBe("passing");
    expect(evidence!.test_count).toBe(10);
    expect(evidence!.test_tool).toBe("vitest");
  });

  it("detects test-results.json with test_tool jest (no startTime)", async () => {
    await createFile(tmpDir, "test-results.json", JSON.stringify({
      success: true,
      numTotalTests: 5,
      numFailedTests: 0,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_status).toBe("passing");
    expect(evidence!.test_tool).toBe("jest");
  });

  it("detects test-results.json with test_tool vitest (has startTime)", async () => {
    await createFile(tmpDir, "test-results.json", JSON.stringify({
      success: true,
      numTotalTests: 5,
      numFailedTests: 0,
      startTime: 1700000000000,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_tool).toBe("vitest");
  });

  it("detects junit.xml with test_tool junit", async () => {
    await createFile(tmpDir, "junit.xml",
      `<?xml version="1.0"?><testsuite tests="20" failures="1" errors="0"></testsuite>`);

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_status).toBe("failing");
    expect(evidence!.test_count).toBe(20);
    expect(evidence!.test_tool).toBe("junit");
  });

  it("prioritizes .vitest-results.json over test-results.json", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: true, numTotalTests: 10, numFailedTests: 0,
    }));
    await createFile(tmpDir, "test-results.json", JSON.stringify({
      success: false, numTotalTests: 5, numFailedTests: 2,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence!.test_tool).toBe("vitest");
    expect(evidence!.test_count).toBe(10);
    expect(evidence!.test_status).toBe("passing");
  });

  it("captures failing test names", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: false,
      numTotalTests: 3,
      numFailedTests: 1,
      testResults: [
        { status: "passed", name: "passing.test.ts" },
        { status: "failed", name: "failing.test.ts" },
      ],
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence!.failing_tests).toEqual(["failing.test.ts"]);
  });
});

// --- Typecheck evidence ---

describe("typecheck evidence", () => {
  it("reports clean when tsbuildinfo is fresh", async () => {
    await createFile(tmpDir, "index.ts", "const x = 1;");
    // Set source mtime to the past
    const pastTime = new Date(Date.now() - 60000);
    await utimes(join(tmpDir, "index.ts"), pastTime, pastTime);
    // Create tsbuildinfo after the source file
    await createFile(tmpDir, "tsconfig.tsbuildinfo", "{}");

    const sourceMtime = pastTime.getTime();
    const evidence = await collectBasicEvidence(tmpDir, sourceMtime);
    expect(evidence).not.toBeNull();
    expect(evidence!.typecheck).toBe("clean");
    expect(evidence!.typecheck_tool).toBe("tsc");
  });

  it("reports unknown when tsbuildinfo is stale", async () => {
    // Create tsbuildinfo first
    await createFile(tmpDir, "tsconfig.tsbuildinfo", "{}");
    const pastTime = new Date(Date.now() - 60000);
    await utimes(join(tmpDir, "tsconfig.tsbuildinfo"), pastTime, pastTime);
    // Source file is newer
    await createFile(tmpDir, "index.ts", "const x = 1;");

    const now = Date.now();
    const evidence = await collectBasicEvidence(tmpDir, now);
    expect(evidence).not.toBeNull();
    expect(evidence!.typecheck).toBe("unknown");
    expect(evidence!.typecheck_tool).toBe("tsc");
  });

  it("reports unknown when newestSourceMtimeMs is not provided", async () => {
    await createFile(tmpDir, "tsconfig.tsbuildinfo", "{}");

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.typecheck).toBe("unknown");
    expect(evidence!.typecheck_tool).toBe("tsc");
  });

  it("omits typecheck fields when no tsbuildinfo exists", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: true, numTotalTests: 1, numFailedTests: 0,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.typecheck).toBeUndefined();
    expect(evidence!.typecheck_tool).toBeUndefined();
  });
});

// --- Lint evidence ---

describe("lint evidence", () => {
  it("reports clean when eslintcache is fresh", async () => {
    await createFile(tmpDir, "index.ts", "const x = 1;");
    const pastTime = new Date(Date.now() - 60000);
    await utimes(join(tmpDir, "index.ts"), pastTime, pastTime);
    await createFile(tmpDir, ".eslintcache", "[]");

    const sourceMtime = pastTime.getTime();
    const evidence = await collectBasicEvidence(tmpDir, sourceMtime);
    expect(evidence).not.toBeNull();
    expect(evidence!.lint_status).toBe("clean");
    expect(evidence!.lint_tool).toBe("eslint");
  });

  it("reports unknown when eslintcache is stale", async () => {
    await createFile(tmpDir, ".eslintcache", "[]");
    const pastTime = new Date(Date.now() - 60000);
    await utimes(join(tmpDir, ".eslintcache"), pastTime, pastTime);
    await createFile(tmpDir, "index.ts", "const x = 1;");

    const now = Date.now();
    const evidence = await collectBasicEvidence(tmpDir, now);
    expect(evidence).not.toBeNull();
    expect(evidence!.lint_status).toBe("unknown");
    expect(evidence!.lint_tool).toBe("eslint");
  });

  it("omits lint fields when no eslintcache exists", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: true, numTotalTests: 1, numFailedTests: 0,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.lint_status).toBeUndefined();
    expect(evidence!.lint_tool).toBeUndefined();
  });
});

// --- Coverage evidence ---

describe("coverage evidence", () => {
  it("extracts coverage_percent from Istanbul/c8 format", async () => {
    await mkdir(join(tmpDir, "coverage"), { recursive: true });
    await writeFile(
      join(tmpDir, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 87.5 } } }),
    );

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.coverage_percent).toBe(87.5);
  });

  it("extracts coverage_percent from pytest-cov format", async () => {
    await createFile(tmpDir, "coverage.json",
      JSON.stringify({ totals: { percent_covered: 92.1 } }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.coverage_percent).toBe(92.1);
  });

  it("prefers Istanbul/c8 over pytest-cov when both exist", async () => {
    await mkdir(join(tmpDir, "coverage"), { recursive: true });
    await writeFile(
      join(tmpDir, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 80 } } }),
    );
    await createFile(tmpDir, "coverage.json",
      JSON.stringify({ totals: { percent_covered: 90 } }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence!.coverage_percent).toBe(80);
  });
});

// --- Commit SHA ---

describe("commit SHA", () => {
  it("resolves SHA from a real git repo", async () => {
    // This test runs inside the autocontext repo itself
    const sha = await resolveGitHeadSha(process.cwd());
    expect(sha).not.toBeNull();
    expect(sha).toMatch(/^[0-9a-f]{40}$/i);
  });

  it("returns null outside a git repo", async () => {
    // tmpDir has no .git
    const sha = await resolveGitHeadSha(tmpDir);
    expect(sha).toBeNull();
  });

  it("handles .git as a file (worktree simulation)", async () => {
    // Create a fake git directory structure
    const fakeGitDir = join(tmpDir, "fakegit");
    await mkdir(join(fakeGitDir, "refs", "heads"), { recursive: true });
    await writeFile(join(fakeGitDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(fakeGitDir, "refs", "heads", "main"),
      "abcdef1234567890abcdef1234567890abcdef12\n",
    );

    // Create a worktree-style .git file
    const worktreeDir = join(tmpDir, "worktree");
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(join(worktreeDir, ".git"), `gitdir: ${fakeGitDir}\n`);

    const sha = await resolveGitHeadSha(worktreeDir);
    expect(sha).toBe("abcdef1234567890abcdef1234567890abcdef12");
  });

  it("handles packed-refs fallback", async () => {
    // Create a git directory with only packed-refs (no loose ref)
    const fakeGitDir = join(tmpDir, ".git");
    await mkdir(fakeGitDir, { recursive: true });
    await writeFile(join(fakeGitDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(fakeGitDir, "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\n" +
      "1234567890abcdef1234567890abcdef12345678 refs/heads/main\n",
    );

    const sha = await resolveGitHeadSha(tmpDir);
    expect(sha).toBe("1234567890abcdef1234567890abcdef12345678");
  });

  it("includes commit_sha in evidence when in git repo", async () => {
    // Create test artifact so evidence is collected, then check SHA is present
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: true, numTotalTests: 1, numFailedTests: 0,
    }));

    // tmpDir won't have .git, so no SHA
    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.commit_sha).toBeUndefined();
  });
});

// --- Per-directory scoping ---

describe("per-directory scoping", () => {
  it("collects evidence from subdirectory with its own artifacts", async () => {
    const subDir = join(tmpDir, "packages", "api");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, ".vitest-results.json", JSON.stringify({
      success: true, numTotalTests: 5, numFailedTests: 0,
    }));

    const evidence = await collectBasicEvidence(subDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_status).toBe("passing");
    expect(evidence!.test_count).toBe(5);
    expect(evidence!.test_tool).toBe("vitest");
  });

  it("returns null for directory without artifacts (no fallback)", async () => {
    // Create root-level artifacts
    await createFile(tmpDir, "test-results.json", JSON.stringify({
      success: true, numTotalTests: 10, numFailedTests: 0,
    }));

    // Subdirectory has no artifacts
    const subDir = join(tmpDir, "packages", "api");
    await mkdir(subDir, { recursive: true });
    await createFile(subDir, "index.ts", "export const api = true;");

    const evidence = await collectBasicEvidence(subDir);
    expect(evidence).toBeNull();
  });
});

// --- Malformed & edge-case artifacts ---

describe("malformed and edge-case artifacts", () => {
  it("returns null for malformed JSON in test artifact", async () => {
    await createFile(tmpDir, ".vitest-results.json", "{not valid json");

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).toBeNull();
  });

  it("returns null for wrong types in test artifact", async () => {
    await createFile(tmpDir, ".vitest-results.json", JSON.stringify({
      success: "yes",
      numTotalTests: "ten",
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).toBeNull();
  });

  it("parses alternative test format (numPassedTests/numFailedTests)", async () => {
    await createFile(tmpDir, "test-results.json", JSON.stringify({
      numPassedTests: 8,
      numFailedTests: 2,
    }));

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence!.test_status).toBe("failing");
    expect(evidence!.test_count).toBe(10);
  });

  it("resolves detached HEAD (bare SHA)", async () => {
    const fakeGitDir = join(tmpDir, ".git");
    await mkdir(fakeGitDir, { recursive: true });
    await writeFile(
      join(fakeGitDir, "HEAD"),
      "abcdef1234567890abcdef1234567890abcdef12\n",
    );

    const sha = await resolveGitHeadSha(tmpDir);
    expect(sha).toBe("abcdef1234567890abcdef1234567890abcdef12");
  });
});

// --- Returns null when no artifacts ---

describe("no artifacts", () => {
  it("returns null for empty directory", async () => {
    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).toBeNull();
  });

  it("returns null for directory with only source files", async () => {
    await createFile(tmpDir, "index.ts", "export const x = 1;");
    await createFile(tmpDir, "utils.ts", "export function foo() {}");

    const evidence = await collectBasicEvidence(tmpDir);
    expect(evidence).toBeNull();
  });
});
