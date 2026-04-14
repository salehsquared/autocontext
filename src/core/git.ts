import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only git helpers. Never shell to write-capable subcommands
 * (clone / init / add / commit / push / pull / fetch / reset / checkout /
 * restore / rebase / merge / cherry-pick / stash / write-side tag or branch).
 * If you need one, put it in src/bench/ (bench does cloning) — never here.
 *
 * `execFileSync` keeps revspecs + paths as separate argv entries so there's
 * no shell-injection surface.
 */

const EXEC_OPTS: {
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  stdio: ["pipe", "pipe", "pipe"];
} = {
  encoding: "utf-8",
  timeout: 30_000,
  maxBuffer: 64 * 1024 * 1024,
  // Capture stderr so callers can decide what to do with failures — by
  // default execFileSync inherits stderr and pollutes our own.
  stdio: ["pipe", "pipe", "pipe"],
};

export class GitError extends Error {
  constructor(
    public code: "NOT_A_REPO" | "BAD_REV" | "NOT_FOUND" | "GIT_FAILED",
    message: string,
    public stderr?: string,
  ) {
    super(message);
  }
}

export interface CommitMeta {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds, committer date. */
  timestamp: number;
  /** First line of the commit message. */
  subject: string;
}

export function isGitRepo(dirPath: string): boolean {
  return existsSync(join(dirPath, ".git"));
}

function runGit(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, { ...EXEC_OPTS, cwd: repoPath });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr =
      e.stderr === undefined
        ? undefined
        : typeof e.stderr === "string"
          ? e.stderr
          : e.stderr.toString("utf8");
    throw new GitError("GIT_FAILED", e.message ?? "git invocation failed", stderr);
  }
}

/** Resolve a revspec to a 40-char SHA. Throws `BAD_REV` on failure. */
export function revParse(repoPath: string, rev: string): string {
  try {
    const out = runGit(repoPath, ["rev-parse", "--verify", rev]);
    return out.trim();
  } catch (err) {
    throw new GitError(
      "BAD_REV",
      `Cannot resolve revision: ${rev}`,
      err instanceof GitError ? err.stderr : undefined,
    );
  }
}

/** Returns file contents at a revision, or null if missing. */
export function showFileAtRev(
  repoPath: string,
  rev: string,
  relPath: string,
): string | null {
  try {
    return runGit(repoPath, ["show", `${rev}:${relPath}`]);
  } catch {
    return null;
  }
}

export interface LogOpts {
  since?: string;
  until?: string;
  max?: number;
  follow?: boolean;
}

export function logForPath(
  repoPath: string,
  relPath: string | ".",
  opts: LogOpts = {},
): CommitMeta[] {
  const args = ["log", "--no-color"];
  if (opts.max) args.push(`-n${opts.max}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  if (opts.follow && relPath !== ".") args.push("--follow");
  args.push("--format=%H%x00%an%x00%ae%x00%ct%x00%s%x1e");
  if (relPath !== ".") args.push("--", relPath);
  const raw = runGit(repoPath, args);
  const out: CommitMeta[] = [];
  for (const rec of raw.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const [sha, authorName, authorEmail, ts, subject] = trimmed.split("\x00");
    if (!sha) continue;
    out.push({
      sha,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      timestamp: Number.parseInt(ts ?? "0", 10) || 0,
      subject: subject ?? "",
    });
  }
  return out;
}

/** Paths changed in a single commit. */
export function getChangedFiles(repoPath: string, sha: string): string[] {
  const out = runGit(repoPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    sha,
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** All paths at `rev`. Optional `filter` predicate trims the result; we
 *  filter in Node because `git ls-tree` doesn't accept pathspec glob magic. */
export function lsTreeFiles(
  repoPath: string,
  rev: string,
  filter?: ((path: string) => boolean) | string,
): string[] {
  const out = runGit(repoPath, ["ls-tree", "-r", "--name-only", rev]);
  let files = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (typeof filter === "string") {
    // Crude glob → regex: ** = anything, * = any non-slash run.
    const re = new RegExp(
      "^" +
        filter
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, ".*") +
        "$",
    );
    files = files.filter((f) => re.test(f));
  } else if (typeof filter === "function") {
    files = files.filter(filter);
  }
  return files;
}

/** git merge-base a b → common ancestor sha; null when disjoint. */
export function mergeBase(
  repoPath: string,
  a: string,
  b: string,
): string | null {
  try {
    return runGit(repoPath, ["merge-base", a, b]).trim() || null;
  } catch {
    return null;
  }
}
