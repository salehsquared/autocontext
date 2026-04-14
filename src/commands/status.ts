import { resolve } from "node:path";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { checkFreshness, legacyState, type FreshnessState } from "../core/fingerprint.js";
import { freshnessIcon, heading, dim, warnMsg } from "../utils/display.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";

interface StatusEntry {
  scope: string;
  state: FreshnessState | "missing";
  fingerprint: string | null;
  summary: string | null;
}

export async function statusCommand(options: { path?: string; json?: boolean }): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  const config = await loadConfig(rootPath);
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs, skipped: skippedCount } = await filterByMinTokens(allDirs, config?.min_tokens);

  let tracked = 0;
  let issues = 0;
  let staleCount = 0;
  let missingCount = 0;
  const entries: StatusEntry[] = [];
  const stalePaths: string[] = [];
  const missingPaths: string[] = [];

  for (const dir of dirs) {
    let context;
    try {
      context = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        const label = dir.relativePath === "." ? "(root)" : dir.relativePath;
        console.error(warnMsg(`${label}: ${err.message}`));
        context = null;
      } else {
        throw err;
      }
    }

    if (context) {
      tracked++;
      const { state } = await checkFreshness(dir.path, context.fingerprint);
      entries.push({
        scope: dir.relativePath,
        state,
        fingerprint: context.fingerprint,
        summary: context.summary,
      });
      if (legacyState(state) === "stale") {
        staleCount++;
        stalePaths.push(dir.relativePath);
        issues++;
      }
    } else {
      entries.push({
        scope: dir.relativePath,
        state: "missing",
        fingerprint: null,
        summary: null,
      });
      missingCount++;
      missingPaths.push(dir.relativePath);
      issues++;
    }
  }

  // Sort entries by scope for deterministic CI diffs
  entries.sort((a, b) => a.scope.localeCompare(b.scope));

  if (options.json) {
    // JSON mode: emit the pre-T2 three-state shape by default — consumers
    // that parse `state === "stale"` must keep working. `freshness_breakdown`
    // carries the 4-state counts for opt-in consumers.
    const legacyEntries = entries.map((e) => ({
      ...e,
      state: legacyState(e.state),
    }));
    process.stdout.write(JSON.stringify({
      root: rootPath,
      directories: legacyEntries,
      summary: {
        total: dirs.length,
        tracked,
        fresh: tracked - staleCount,
        stale: staleCount,
        missing: missingCount,
        skipped: skippedCount,
      },
    }, null, 2) + "\n");
    return;
  }

  // Human-readable output
  console.log("");

  for (const entry of entries) {
    const label = entry.scope === "." ? "(root)" : entry.scope;
    console.log(`  ${freshnessIcon(entry.state)}  ${label}`);

    if (legacyState(entry.state) === "stale") {
      console.log(`               (files changed since last update)`);
    }
  }

  console.log(heading(`\ncontext health: ${tracked} of ${dirs.length} directories tracked\n`));

  if (skippedCount > 0) {
    console.log(dim(`  ${skippedCount} directories below token threshold (skipped)\n`));
  }

  if (issues > 0) {
    console.log(`${issues} issue${issues > 1 ? "s" : ""} found. Run:`);
    for (const path of stalePaths) {
      console.log(`  context regen ${path}        # regenerate stale context`);
    }
    for (const path of missingPaths) {
      console.log(`  context regen ${path}        # generate context for new directory`);
    }
    console.log("");
  }
}
