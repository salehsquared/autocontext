#!/usr/bin/env node
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const rootPath = resolve(".");
const hooksPath = resolve(rootPath, ".githooks");
const preCommitPath = resolve(hooksPath, "pre-commit");

chmodSync(preCommitPath, 0o755);
run("git", ["config", "core.hooksPath", ".githooks"], { cwd: rootPath });

process.stdout.write("[autocontext] Installed git hooks (.githooks/pre-commit).\n");
