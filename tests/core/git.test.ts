import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  GitError,
  isGitRepo,
  logForPath,
  lsTreeFiles,
  mergeBase,
  revParse,
  showFileAtRev,
} from "../../src/core/git.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("isGitRepo", () => {
  it("recognizes the autocontext repo", () => {
    expect(isGitRepo(repoRoot)).toBe(true);
  });
  it("returns false for a non-repo", () => {
    expect(isGitRepo("/tmp")).toBe(false);
  });
});

describe("revParse", () => {
  it("resolves HEAD to a 40-char SHA", () => {
    const sha = revParse(repoRoot, "HEAD");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
  it("throws GitError(BAD_REV) on an unknown rev", () => {
    try {
      revParse(repoRoot, "definitely-not-a-real-rev-12345");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).code).toBe("BAD_REV");
    }
  });
});

describe("showFileAtRev", () => {
  it("returns the package.json contents at HEAD", () => {
    const raw = showFileAtRev(repoRoot, "HEAD", "package.json");
    expect(raw).not.toBeNull();
    expect(raw).toContain('"name": "autocontext"');
  });
  it("returns null for a missing path", () => {
    expect(showFileAtRev(repoRoot, "HEAD", "src/does-not-exist.txt")).toBeNull();
  });
});

describe("logForPath", () => {
  it("returns commits newest-first for a tracked file", () => {
    const commits = logForPath(repoRoot, "package.json", { max: 5 });
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.timestamp).toBeGreaterThan(0);
      expect(typeof c.subject).toBe("string");
    }
    // newest-first ordering
    for (let i = 1; i < commits.length; i++) {
      expect(commits[i].timestamp).toBeLessThanOrEqual(commits[i - 1].timestamp);
    }
  });
  it("returns commits for the whole repo when path is '.'", () => {
    const commits = logForPath(repoRoot, ".", { max: 3 });
    expect(commits.length).toBeGreaterThan(0);
  });
});

describe("lsTreeFiles", () => {
  it("lists every .context.yaml at HEAD", () => {
    const files = lsTreeFiles(repoRoot, "HEAD", (f) => f.endsWith(".context.yaml"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".context.yaml"))).toBe(true);
  });
});

describe("mergeBase", () => {
  it("returns a SHA for two known commits", () => {
    const head = revParse(repoRoot, "HEAD");
    const result = mergeBase(repoRoot, head, head);
    expect(result).toBe(head);
  });
});
