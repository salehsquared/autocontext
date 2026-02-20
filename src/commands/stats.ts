import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { checkFreshness, type FreshnessState } from "../core/fingerprint.js";
import { heading, dim, warnMsg } from "../utils/display.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import {
  estimateDirectoryTokens,
  estimateContextFileTokens,
  filterByMinTokens,
  collectExtensions,
} from "../utils/tokens.js";
import type { ScanResult } from "../core/scanner.js";
import type { ContextFile } from "../core/schema.js";

// --- Helpers ---

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// --- Per-directory data ---

interface DirStats {
  scope: string;
  sourceTokens: number;
  contextTokens: number;
  reductionPercent: number;
  freshness: FreshnessState | "missing";
  fileCount: number;
  exportCount: number;
  hasDecisions: boolean;
  hasConstraints: boolean;
  hasDependencies: boolean;
  hasImports: boolean;
  hasInternals: boolean;
  summaryIsFallback: boolean;
  contextLagHours: number | null;
  extensions: string[];
}

// --- Signal density (0-5) ---

function signalScore(d: DirStats): number {
  let s = 0;
  if (!d.summaryIsFallback) s++;
  if (d.exportCount > 0) s++;
  if (d.hasDecisions) s++;
  if (d.hasConstraints) s++;
  if (d.hasDependencies) s++;
  return s;
}

// --- Context lag for stale dirs ---

async function computeContextLag(
  dir: ScanResult,
  context: ContextFile,
): Promise<number | null> {
  if (!context.last_updated) return null;

  const lastUpdated = new Date(context.last_updated).getTime();
  if (Number.isNaN(lastUpdated)) return null;

  let maxMtime = 0;
  for (const file of dir.files) {
    try {
      const s = await stat(join(dir.path, file));
      if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
    } catch { /* skip */ }
  }

  if (maxMtime === 0) return null;
  const lagMs = maxMtime - lastUpdated;
  if (lagMs <= 0) return null;
  return lagMs / (1000 * 60 * 60); // hours
}

// --- Extensions from a single dir ---

function dirExtensions(files: string[]): string[] {
  const exts = new Set<string>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot > 0) exts.add(f.slice(dot));
  }
  return [...exts].sort();
}

// --- Main ---

export async function statsCommand(options: { path?: string; json?: boolean }): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  const config = await loadConfig(rootPath);
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs, skipped: skippedCount } = await filterByMinTokens(allDirs, config?.min_tokens);

  if (dirs.length === 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ error: "No directories with source files found." }, null, 2) + "\n");
    } else {
      console.log("\n  No directories with source files found.\n");
    }
    return;
  }

  // Collect per-directory stats
  const entries: DirStats[] = [];
  let tracked = 0;
  let totalSourceTokens = 0;
  let trackedSourceTokens = 0;
  let totalContextTokens = 0;
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;
  let freshTokensSaved = 0;
  let totalFileCount = 0;
  const staleLags: number[] = [];
  // Quality accumulators
  let fallbackCount = 0;
  let totalExportCount = 0;
  let dirsWithExports = 0;
  let dirsWithDecisions = 0;
  let dirsWithConstraints = 0;
  let dirsWithDependencies = 0;
  let dirsWithImports = 0;
  let dirsWithInternals = 0;

  for (const dir of dirs) {
    const sourceTokens = await estimateDirectoryTokens(dir);
    const contextTokens = await estimateContextFileTokens(dir.path);
    let context;
    try {
      context = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        console.error(warnMsg(`${dir.relativePath}: ${err.message}`));
        context = null;
      } else {
        throw err;
      }
    }
    totalSourceTokens += sourceTokens;
    totalFileCount += dir.files.length;

    let freshness: FreshnessState | "missing" = "missing";
    let lagHours: number | null = null;

    if (context) {
      tracked++;
      trackedSourceTokens += sourceTokens;
      totalContextTokens += contextTokens;
      const { state } = await checkFreshness(dir.path, context.fingerprint);
      freshness = state;

      if (state === "fresh") {
        freshCount++;
        if (sourceTokens > contextTokens) freshTokensSaved += sourceTokens - contextTokens;
      } else if (state === "stale") {
        staleCount++;
        lagHours = await computeContextLag(dir, context);
        if (lagHours !== null) staleLags.push(lagHours);
      }
    } else {
      missingCount++;
    }

    const summaryIsFallback = context?.summary === "Source directory.";
    const exportCount = context?.exports?.length ?? 0;
    const hasDecisions = (context?.decisions?.length ?? 0) > 0;
    const hasConstraints = (context?.constraints?.length ?? 0) > 0;
    const hasDependencies = context?.dependencies !== undefined &&
      ((context.dependencies.internal?.length ?? 0) > 0 || (context.dependencies.external?.length ?? 0) > 0);
    const hasImports = (context?.imports?.length ?? 0) > 0;
    const hasInternals = (context?.internals?.length ?? 0) > 0;

    if (context) {
      if (summaryIsFallback) fallbackCount++;
      if (exportCount > 0) { dirsWithExports++; totalExportCount += exportCount; }
      if (hasDecisions) dirsWithDecisions++;
      if (hasConstraints) dirsWithConstraints++;
      if (hasDependencies) dirsWithDependencies++;
      if (hasImports) dirsWithImports++;
      if (hasInternals) dirsWithInternals++;
    }

    const reductionPercent = sourceTokens > 0 ? round1((1 - contextTokens / sourceTokens) * 100) : 0;

    entries.push({
      scope: dir.relativePath,
      sourceTokens,
      contextTokens,
      reductionPercent,
      freshness,
      fileCount: dir.files.length,
      exportCount,
      hasDecisions,
      hasConstraints,
      hasDependencies,
      hasImports,
      hasInternals,
      summaryIsFallback,
      contextLagHours: lagHours,
      extensions: dirExtensions(dir.files),
    });
  }

  entries.sort((a, b) => a.scope.localeCompare(b.scope));

  // Aggregate metrics (reduction only counts tracked dirs — missing dirs aren't "savings")
  const tokensSaved = trackedSourceTokens - totalContextTokens;
  const reductionPercent = trackedSourceTokens > 0 ? round1((1 - totalContextTokens / trackedSourceTokens) * 100) : 0;
  const reductionRatio = totalContextTokens > 0 ? round1(trackedSourceTokens / totalContextTokens) : 0;

  // Per-directory percentiles (only tracked dirs with source > 0)
  const perDirReductions = entries
    .filter((e) => e.freshness !== "missing" && e.sourceTokens > 0)
    .map((e) => e.reductionPercent)
    .sort((a, b) => a - b);
  const p50 = perDirReductions.length >= 2 ? round1(percentile(perDirReductions, 50)) : null;
  const p95 = perDirReductions.length >= 2 ? round1(percentile(perDirReductions, 95)) : null;

  // Freshness
  const freshRate = tracked > 0 ? round1((freshCount / tracked) * 1000) / 1000 : 0;
  const stalenessPenalty = tokensSaved - freshTokensSaved;

  // Quality
  const summaryQualityRate = tracked > 0 ? round1(((tracked - fallbackCount) / tracked) * 1000) / 1000 : 0;
  const signalDensitySum = entries.filter((e) => e.freshness !== "missing").reduce((sum, e) => sum + signalScore(e), 0);
  const signalDensityAvg = tracked > 0 ? round1(signalDensitySum / tracked) : 0;

  // Context lag
  staleLags.sort((a, b) => a - b);
  const lagMedian = staleLags.length > 0 ? round1(percentile(staleLags, 50)) : null;

  // Languages
  const languages = collectExtensions(dirs);

  if (options.json) {
    const output = {
      root: rootPath,
      directories: entries.map((e) => ({
        scope: e.scope,
        source_tokens: e.sourceTokens,
        context_tokens: e.contextTokens,
        reduction_percent: e.reductionPercent,
        freshness: e.freshness,
        file_count: e.fileCount,
        export_count: e.exportCount,
        has_decisions: e.hasDecisions,
        has_constraints: e.hasConstraints,
        has_dependencies: e.hasDependencies,
        has_imports: e.hasImports,
        has_internals: e.hasInternals,
        summary_is_fallback: e.summaryIsFallback,
        context_lag_hours: e.contextLagHours,
        extensions: e.extensions,
      })),
      token_economics: {
        source_tokens: totalSourceTokens,
        tracked_source_tokens: trackedSourceTokens,
        context_tokens: totalContextTokens,
        tokens_saved: tokensSaved,
        reduction_percent: reductionPercent,
        reduction_ratio: reductionRatio,
        per_directory_reduction_p50: p50,
        per_directory_reduction_p95: p95,
      },
      freshness: {
        tracked,
        fresh: freshCount,
        stale: staleCount,
        missing: missingCount,
        fresh_rate: freshRate,
        fresh_tokens_saved: freshTokensSaved,
        staleness_penalty: stalenessPenalty,
        context_lag_median_hours: lagMedian,
      },
      quality: {
        summary_quality_rate: summaryQualityRate,
        summary_fallback_count: fallbackCount,
        signal_density_avg: signalDensityAvg,
        exports_coverage: tracked > 0 ? round1((dirsWithExports / tracked) * 1000) / 1000 : 0,
        decisions_coverage: tracked > 0 ? round1((dirsWithDecisions / tracked) * 1000) / 1000 : 0,
        constraints_coverage: tracked > 0 ? round1((dirsWithConstraints / tracked) * 1000) / 1000 : 0,
        dependencies_coverage: tracked > 0 ? round1((dirsWithDependencies / tracked) * 1000) / 1000 : 0,
        imports_coverage: tracked > 0 ? round1((dirsWithImports / tracked) * 1000) / 1000 : 0,
        internals_coverage: tracked > 0 ? round1((dirsWithInternals / tracked) * 1000) / 1000 : 0,
      },
      codebase: {
        total_directories: dirs.length,
        tracked,
        skipped: skippedCount,
        total_source_files: totalFileCount,
        languages,
      },
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // --- Human-readable output ---
  console.log("");

  // Codebase
  console.log(heading("  Codebase"));
  console.log(`    ${dirs.length} directories (${tracked} tracked${skippedCount > 0 ? `, ${skippedCount} skipped below token threshold` : ""}${missingCount > 0 ? `, ${missingCount} missing context` : ""})`);
  console.log(`    ${fmtNum(totalFileCount)} source files \u00b7 ~${fmtNum(totalSourceTokens)} estimated tokens`);

  // Token Reduction
  if (tracked > 0) {
    console.log("");
    console.log(heading("  Token Reduction"));
    console.log(`    ~${fmtNum(trackedSourceTokens)} source \u2192 ~${fmtNum(totalContextTokens)} context (${reductionPercent}% reduction${reductionRatio > 0 ? `, ${reductionRatio}x smaller` : ""})`);
    console.log(`    ~${fmtNum(tokensSaved)} tokens saved`);
    if (p50 !== null && p95 !== null) {
      console.log(`    per-directory: p50 ${p50}%  p95 ${p95}%`);
    }
  }

  // Freshness-Adjusted Impact
  if (tracked > 0) {
    console.log("");
    console.log(heading("  Freshness-Adjusted Impact"));
    const freshPct = round1((freshCount / tracked) * 100);
    console.log(`    ${freshCount} fresh, ${staleCount} stale, ${missingCount} missing (${freshPct}% fresh)`);
    if (staleCount > 0) {
      console.log(`    fresh savings: ~${fmtNum(freshTokensSaved)} tokens  |  staleness penalty: ~${fmtNum(stalenessPenalty)} tokens`);
      if (lagMedian !== null) {
        console.log(`    median context lag: ${lagMedian}h (stale dirs only)`);
      }
    } else {
      console.log(dim("    all contexts fresh"));
    }
  }

  // Context Quality
  if (tracked > 0) {
    console.log("");
    console.log(heading("  Context Quality"));
    const qualPct = round1(summaryQualityRate * 100);
    console.log(`    summary quality:  ${qualPct}%${fallbackCount > 0 ? ` (${fallbackCount} fallback)` : ""}`);
    console.log(`    signal density:   ${signalDensityAvg} / 5 avg fields per directory`);
    console.log(`    exports:          ${dirsWithExports}/${tracked} dirs (${fmtNum(totalExportCount)} signatures)`);
    console.log(`    decisions:        ${dirsWithDecisions}/${tracked} dirs`);
    console.log(`    constraints:      ${dirsWithConstraints}/${tracked} dirs`);
    console.log(`    dependencies:     ${dirsWithDependencies}/${tracked} dirs`);
    console.log(`    imports:          ${dirsWithImports}/${tracked} dirs`);
    console.log(`    internals:        ${dirsWithInternals}/${tracked} dirs`);
  }

  // Breakdown table
  console.log("");
  console.log(heading("  Breakdown"));

  const scopeWidth = Math.max(22, ...entries.map((e) => (e.scope === "." ? "(root)" : e.scope).length));
  const header = `    ${"scope".padEnd(scopeWidth)}  ${"source".padStart(8)}  ${"context".padStart(8)}  ${"reduction".padStart(10)}`;
  console.log(header);
  console.log(`    ${"\u2500".repeat(scopeWidth + 32)}`);

  for (const entry of entries) {
    const label = entry.scope === "." ? "(root)" : entry.scope;
    const src = `~${fmtNum(entry.sourceTokens)}`;
    const ctx = entry.freshness === "missing" ? "\u2014" : `~${fmtNum(entry.contextTokens)}`;
    const red = entry.freshness === "missing" || entry.sourceTokens === 0
      ? "\u2014"
      : `${entry.reductionPercent}% (${entry.sourceTokens > 0 && entry.contextTokens > 0 ? Math.round(entry.sourceTokens / entry.contextTokens) : 0}x)`;
    const staleMarker = entry.freshness === "stale" ? dim(" \u26a0") : "";
    console.log(`    ${label.padEnd(scopeWidth)}  ${src.padStart(8)}  ${ctx.padStart(8)}  ${red.padStart(10)}${staleMarker}`);
  }

  // Languages
  const langEntries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  if (langEntries.length > 0) {
    console.log("");
    console.log(heading("  Languages"));
    const langParts = langEntries.map(([ext, count]) => `${ext}  ${count}`);
    console.log(`    ${langParts.join("    ")}`);
  }

  // No tracked hint
  if (tracked === 0) {
    console.log("");
    console.log("  No .context.yaml files found. Run `context init` to get started.");
  }

  console.log("");
}
