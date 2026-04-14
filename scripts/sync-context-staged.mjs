#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").trim();
}

function collectContextFiles(rootPath, currentPath = rootPath, out = []) {
  const entries = readdirSync(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      collectContextFiles(rootPath, join(currentPath, entry.name), out);
      continue;
    }

    if (!entry.isFile()) continue;
    if (basename(entry.name) !== ".context.yaml") continue;

    out.push(relative(rootPath, join(currentPath, entry.name)));
  }
  return out;
}

const rootPath = capture("git", ["rev-parse", "--show-toplevel"]);

// Only run sync if there are staged changes outside context artifacts.
const staged = capture("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: rootPath });
if (!staged) {
  process.exit(0);
}
const hasNonContextChanges = staged.split("\n").some((path) =>
  path
  && !path.endsWith("/.context.yaml")
  && path !== ".context.yaml"
  && path !== "AGENTS.md",
);
if (!hasNonContextChanges) {
  process.exit(0);
}

// Ensure the code index is warm before classifying staleness. The `index`
// command is idempotent and incremental; <100ms on a warm clone, a full
// build on a cold one.
const idx = spawnSync("node", ["dist/index.js", "index", "-p", rootPath], {
  cwd: rootPath,
  stdio: "inherit",
});
// When the index is available, prefer the semantic gate — formatter /
// comment-only diffs no longer trigger regen. Falls back to the legacy
// cosmetic-aware gate on any index failure so the hook stays robust.
const gateFlag = idx.status === 0 ? "--semantic-stale" : "--stale";
if (idx.status !== 0) {
  process.stderr.write("[autocontext] index build failed; falling back to --stale gate\n");
}

run("node", ["dist/index.js", "regen", "--all", gateFlag, "--no-llm", "--no-agents", "-p", rootPath], {
  cwd: rootPath,
});

const contextFiles = collectContextFiles(rootPath);
if (contextFiles.length > 0) {
  run("git", ["add", "--", ...contextFiles], { cwd: rootPath });
}

process.stdout.write(`[autocontext] Synced and staged ${contextFiles.length} context files.\n`);
