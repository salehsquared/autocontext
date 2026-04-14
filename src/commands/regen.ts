import { resolve, relative, isAbsolute } from "node:path";
import { scanProject, flattenBottomUp, groupByDepth } from "../core/scanner.js";
import { readContext, writeContext, UnsupportedVersionError } from "../core/writer.js";
import { checkFreshness } from "../core/fingerprint.js";
import { generateStaticContext, type SummarySource } from "../generator/static.js";
import { generateLLMContext } from "../generator/llm.js";
import { createProvider } from "../providers/index.js";
import { loadConfig, resolveApiKey } from "../utils/config.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { successMsg, errorMsg, warnMsg, progressBar, freshnessIcon, dim } from "../utils/display.js";
import { updateAgentsMd } from "../core/markdown-writer.js";
import { poolMap } from "../utils/pool.js";
import { filterByMinTokens, estimateDirectoryTokens, estimateContextFileTokens } from "../utils/tokens.js";
import type { ContextFile } from "../core/schema.js";
import type { ScanResult } from "../core/scanner.js";
import { indexCommand } from "./index-cmd.js";

interface GenerationMetrics {
  total_scanned: number;
  skipped_min_tokens: number;
  generated: number;
  exports_extracted: number;
  exports_total: number;
  summary_from_docstring: number;
  summary_from_dirname: number;
  summary_from_pattern: number;
  summary_from_project: number;
  summary_fallback: number;
  total_source_tokens: number;
  total_context_tokens: number;
  generation_start_ms: number;
}

function trackSummarySource(metrics: GenerationMetrics, source: SummarySource): void {
  if (source === "docstring") metrics.summary_from_docstring++;
  else if (source === "dirname") metrics.summary_from_dirname++;
  else if (source === "pattern") metrics.summary_from_pattern++;
  else if (source === "project") metrics.summary_from_project++;
  else metrics.summary_fallback++;
}

function printMetrics(metrics: GenerationMetrics): void {
  console.log(dim("\n  metrics:"));
  console.log(dim(`    scanned ${metrics.total_scanned} directories, skipped ${metrics.skipped_min_tokens} (below token threshold), generated ${metrics.generated}`));
  console.log(dim(`    exports: ${metrics.exports_extracted}/${metrics.generated} directories (${metrics.exports_total} signatures)`));
  const parts: string[] = [];
  if (metrics.summary_from_project > 0) parts.push(`${metrics.summary_from_project} from project description`);
  if (metrics.summary_from_docstring > 0) parts.push(`${metrics.summary_from_docstring} from docstrings`);
  if (metrics.summary_from_dirname > 0) parts.push(`${metrics.summary_from_dirname} from directory names`);
  if (metrics.summary_from_pattern > 0) parts.push(`${metrics.summary_from_pattern} from file patterns`);
  if (metrics.summary_fallback > 0) parts.push(`${metrics.summary_fallback} fallback`);
  console.log(dim(`    summaries: ${parts.join(", ")}`));
  if (metrics.total_source_tokens > 0 && metrics.total_context_tokens > 0) {
    const pct = ((1 - metrics.total_context_tokens / metrics.total_source_tokens) * 100).toFixed(1);
    const ratio = Math.round(metrics.total_source_tokens / metrics.total_context_tokens);
    const saved = (metrics.total_source_tokens - metrics.total_context_tokens).toLocaleString("en-US");
    console.log(dim(`    token reduction: ${pct}% (${ratio}x) \u2014 ${saved} tokens saved`));
  }
  const elapsed = ((Date.now() - metrics.generation_start_ms) / 1000).toFixed(1);
  console.log(dim(`    completed in ${elapsed}s`));
}

export async function regenCommand(
  targetPath: string | undefined,
  options: {
    all?: boolean;
    force?: boolean;
    noLlm?: boolean;
    path?: string;
    evidence?: boolean;
    noAgents?: boolean;
    stale?: boolean;
    /** Subset of --stale: regenerate only directories whose semantic
     *  fingerprint differs. Skips cosmetic_stale (formatter churn). Used by
     *  the pre-commit hook post-T2. */
    semanticStale?: boolean;
    dryRun?: boolean;
    parallel?: number;
    full?: boolean;
  },
): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);

  // Load config
  const config = await loadConfig(rootPath);

  // Filter by token threshold
  const { dirs: filteredDirs, skipped } = await filterByMinTokens(allDirs, config?.min_tokens);

  // Determine which directories to regenerate
  let dirs: ScanResult[] = filteredDirs;
  if (!options.all && targetPath) {
    const resolvedTarget = resolve(rootPath, targetPath);
    const targetRelFromRoot = relative(rootPath, resolvedTarget);
    const targetInsideRoot = targetRelFromRoot === "" || (!targetRelFromRoot.startsWith("..") && !isAbsolute(targetRelFromRoot));

    if (targetInsideRoot) {
      dirs = filteredDirs.filter((d) => {
        const rel = relative(resolvedTarget, d.path);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
    } else {
      dirs = [];
    }

    if (dirs.length === 0) {
      console.log(errorMsg(`No matching directory found for: ${targetPath}`));
      return;
    }
  }

  // Set up provider
  let provider = null;
  if (!options.noLlm && config) {
    const credential = resolveApiKey(config);
    if (config.provider === "ollama" || credential) {
      provider = await createProvider(config.provider, credential, config.model);
    }
  }

  const childContexts = new Map<string, ContextFile>();

  // Pre-populate child contexts from existing files
  for (const dir of allDirs) {
    let existing;
    try {
      existing = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        console.log(warnMsg(`${dir.relativePath}: ${err.message} (will regenerate)`));
        existing = null;
      } else {
        throw err;
      }
    }
    if (existing) childContexts.set(dir.path, existing);
  }

  // --stale / --semantic-stale: filter to the set of directories that need regen.
  if (options.stale || options.semanticStale) {
    const { hasIndex } = await import("../core/semantic-fingerprint-writer.js");
    const indexAvailable = hasIndex(rootPath);
    let indexStore: import("../index/store.js").IndexStore | null = null;
    if (options.semanticStale && indexAvailable) {
      const { openIndex } = await import("../index/store.js");
      try {
        indexStore = await openIndex(rootPath, { readOnly: true, autoRebuild: false });
      } catch {
        indexStore = null;
      }
    }
    const { extractPolicyFacts } = await import("../core/semantic-fingerprint.js");

    try {
      const picked: ScanResult[] = [];
      for (const dir of dirs) {
        const existing = childContexts.get(dir.path);
        if (!existing) {
          picked.push(dir);
          continue;
        }
        const { state } = await checkFreshness(dir.path, existing.fingerprint, [], {
          storedSemanticFingerprint: existing.semantic_fingerprint,
          index: indexStore ?? undefined,
          contextFacts: extractPolicyFacts(existing),
          projectRoot: rootPath,
        });
        if (options.semanticStale) {
          // Skip cosmetic_stale; only semantic_stale and missing qualify.
          if (state === "semantic_stale" || state === "missing") picked.push(dir);
        } else {
          if (state !== "fresh") picked.push(dir);
        }
      }
      dirs = picked;
    } finally {
      if (indexStore) await indexStore.close();
    }

    if (dirs.length === 0) {
      const label = options.semanticStale ? "semantically fresh" : "fresh";
      console.log(successMsg(`All contexts are ${label}. Nothing to regenerate.`));
      return;
    }
  }

  // --dry-run: print what would be regenerated and exit
  if (options.dryRun) {
    console.log(`\nWould regenerate ${dirs.length} director${dirs.length > 1 ? "ies" : "y"}:\n`);
    for (const dir of dirs) {
      const existing = childContexts.get(dir.path);
      const { state } = existing
        ? await checkFreshness(dir.path, existing.fingerprint)
        : { state: "missing" as const };
      const label = dir.relativePath === "." ? "(root)" : dir.relativePath;
      console.log(`  ${freshnessIcon(state)}  ${label}`);
    }
    if (skipped > 0) {
      console.log(dim(`\n  ${skipped} directories skipped (below token threshold)`));
    }
    console.log("");
    return;
  }

  console.log(`\nRegenerating context for ${dirs.length} director${dirs.length > 1 ? "ies" : "y"}...`);
  if (skipped > 0) {
    console.log(dim(`  ${skipped} directories skipped (below token threshold)`));
  }

  let completed = 0;
  const configMode = config?.mode ?? "lean";
  const mode = options.full ? "full" as const : configMode;
  const genOptions = { evidence: options.evidence, mode };

  const metrics: GenerationMetrics = {
    total_scanned: allDirs.length,
    skipped_min_tokens: skipped,
    generated: 0,
    exports_extracted: 0,
    exports_total: 0,
    summary_from_docstring: 0,
    summary_from_dirname: 0,
    summary_from_pattern: 0,
    summary_from_project: 0,
    summary_fallback: 0,
    total_source_tokens: 0,
    total_context_tokens: 0,
    generation_start_ms: Date.now(),
  };

  if (options.parallel && options.parallel > 1) {
    // Parallel mode: process by depth layers
    const depthGroups = groupByDepth(scanResult);
    const targetPaths = new Set(dirs.map((d) => d.path));

    for (const group of depthGroups) {
      const layerDirs = group.filter((d) => targetPaths.has(d.path));
      if (layerDirs.length === 0) continue;

      await poolMap(layerDirs, async (dir) => {
        try {
          let context: ContextFile;
          if (provider) {
            context = await generateLLMContext(provider, dir, childContexts, genOptions);
          } else {
            const result = await generateStaticContext(dir, childContexts, genOptions);
            context = result.context;
            trackSummarySource(metrics, result.summarySource);
          }
          await writeContext(dir.path, context);
          childContexts.set(dir.path, context);
          completed++;
          metrics.generated++;
          metrics.total_source_tokens += await estimateDirectoryTokens(dir);
          metrics.total_context_tokens += await estimateContextFileTokens(dir.path);
          if (context.exports && context.exports.length > 0) {
            metrics.exports_extracted++;
            metrics.exports_total += context.exports.length;
          }
          console.log(successMsg(`${dir.relativePath}/.context.yaml updated`));
        } catch (err) {
          completed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.log(errorMsg(`${dir.relativePath}: ${msg}`));
        }
      }, options.parallel);
    }
  } else {
    // Sequential mode (default)
    for (const dir of dirs) {
      process.stdout.write(`\r${progressBar(completed, dirs.length)}`);

      try {
        let context: ContextFile;
        if (provider) {
          context = await generateLLMContext(provider, dir, childContexts, genOptions);
        } else {
          const result = await generateStaticContext(dir, childContexts, genOptions);
          context = result.context;
          trackSummarySource(metrics, result.summarySource);
        }

        await writeContext(dir.path, context);
        childContexts.set(dir.path, context);

        completed++;
        metrics.generated++;
        metrics.total_source_tokens += await estimateDirectoryTokens(dir);
        metrics.total_context_tokens += await estimateContextFileTokens(dir.path);
        if (context.exports && context.exports.length > 0) {
          metrics.exports_extracted++;
          metrics.exports_total += context.exports.length;
        }
        console.log(`\n${successMsg(`${dir.relativePath}/.context.yaml updated`)}`);
      } catch (err) {
        completed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n${errorMsg(`${dir.relativePath}: ${msg}`)}`);
      }
    }
  }

  // Update AGENTS.md only on full-tree runs
  const isFullTree = options.all || (options.stale && !targetPath);
  if (isFullTree && !options.noAgents) {
    const entries = Array.from(childContexts.values())
      .map((ctx) => ({ scope: ctx.scope, summary: ctx.summary }))
      .sort((a, b) => {
        if (a.scope === ".") return -1;
        if (b.scope === ".") return 1;
        return a.scope.localeCompare(b.scope);
      });

    const rootContext = childContexts.get(rootPath)
      ?? Array.from(childContexts.values()).find((c) => c.scope === ".");
    const projectName = rootContext?.project?.name ?? "this project";

    try {
      const action = await updateAgentsMd(rootPath, entries, projectName);
      if (action === "created") console.log(successMsg("AGENTS.md created"));
      else if (action === "appended") console.log(successMsg("AGENTS.md updated (section appended)"));
      else if (action === "replaced") console.log(successMsg("AGENTS.md updated (section refreshed)"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(warnMsg(`AGENTS.md: ${msg}`));
    }
  }

  console.log(`\nDone. ${completed} file${completed > 1 ? "s" : ""} regenerated.`);
  printMetrics(metrics);

  // Keep the local code index in sync. Only on full-tree runs (same guard as
  // AGENTS.md) — targeted regens leave the index alone so we don't thrash.
  if (isFullTree) {
    try {
      await indexCommand({ path: rootPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(warnMsg(`code index: ${msg}`));
    }

    // Stamp semantic fingerprints into the regenerated yamls.
    try {
      const { stampSemanticFingerprintsForDirs } = await import(
        "../core/semantic-fingerprint-writer.js"
      );
      const stamped = await stampSemanticFingerprintsForDirs(rootPath, dirs);
      if (stamped.updated > 0) {
        console.log(
          dim(`  semantic fingerprints: ${stamped.updated} directory${stamped.updated === 1 ? "" : "ies"} stamped`),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(warnMsg(`semantic fingerprints: ${msg}`));
    }
  }

  console.log("");
}
