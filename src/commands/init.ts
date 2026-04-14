import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { scanProject, flattenBottomUp, groupByDepth } from "../core/scanner.js";
import { writeContext } from "../core/writer.js";
import { generateStaticContext, type SummarySource } from "../generator/static.js";
import { generateLLMContext } from "../generator/llm.js";
import { createProvider, type ProviderName } from "../providers/index.js";
import { loadConfig, saveConfig, resolveApiKey } from "../utils/config.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { successMsg, errorMsg, warnMsg, progressBar, heading, dim } from "../utils/display.js";
import { updateAgentsMd } from "../core/markdown-writer.js";
import { ensureAutocontextGitignored } from "../core/gitignore.js";
import { indexCommand } from "./index-cmd.js";
import { poolMap } from "../utils/pool.js";
import { filterByMinTokens, estimateDirectoryTokens, estimateContextFileTokens, DEFAULT_MIN_TOKENS } from "../utils/tokens.js";
import type { ContextFile, ConfigFile } from "../core/schema.js";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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

export async function initCommand(options: { noLlm?: boolean; path?: string; evidence?: boolean; noAgents?: boolean; parallel?: number; full?: boolean }): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  console.log(heading("\nWelcome to context.\n"));

  const existingConfig = await loadConfig(rootPath);
  let config: ConfigFile | null = null;

  if (!options.noLlm) {
    // Prompt for provider
    console.log("Which LLM provider would you like to use for generating context?");
    console.log("  1. Anthropic (Claude)");
    console.log("  2. OpenAI (GPT)");
    console.log("  3. Google (Gemini)");
    console.log("  4. Ollama (local)");

    const choice = await ask("  > ");
    const providers: Record<string, ProviderName> = {
      "1": "anthropic",
      "2": "openai",
      "3": "google",
      "4": "ollama",
    };

    const providerName = providers[choice];
    if (!providerName) {
      console.log(errorMsg("Invalid choice. Run `context init --no-llm` for offline mode."));
      process.exit(1);
    }

    config = { ...(existingConfig ?? {}), provider: providerName };

    // Check for API key
    const apiKey = resolveApiKey(config);
    if (!apiKey && providerName !== "ollama") {
      const envVar = providerName === "anthropic" ? "ANTHROPIC_API_KEY"
        : providerName === "openai" ? "OPENAI_API_KEY"
        : "GOOGLE_API_KEY";

      const key = await ask(`Enter your API key (or set ${envVar}):\n  > `);
      if (!key) {
        console.log(errorMsg(`No API key provided. Set ${envVar} or run with --no-llm.`));
        process.exit(1);
      }
      // Set for this session
      process.env[envVar] = key;
    }

    await saveConfig(rootPath, config);
  }

  // Scan project
  console.log("\nScanning project structure...");
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);

  // Filter by token threshold
  const resolvedConfig = config ?? existingConfig;
  const { dirs, skipped } = await filterByMinTokens(allDirs, resolvedConfig?.min_tokens);

  console.log(`Found ${allDirs.length} directories with source code.`);
  if (skipped > 0) {
    console.log(dim(`  ${skipped} directories skipped (below token threshold)`));
  }
  console.log("");

  if (dirs.length === 0) {
    if (skipped > 0) {
      console.log(errorMsg(`All ${skipped} directories were below the token threshold (${resolvedConfig?.min_tokens ?? DEFAULT_MIN_TOKENS} tokens). Lower min_tokens in .context.config.yaml or set to 0 to disable filtering.`));
    } else {
      console.log(errorMsg("No directories with source files found."));
    }
    return;
  }

  // Generate context files
  console.log(options.noLlm
    ? "Generating structural context (no LLM)..."
    : "Generating context... (this may take a minute)");

  const provider = (!options.noLlm && config)
    ? await createProvider(config.provider, resolveApiKey(config), config.model)
    : null;

  const childContexts = new Map<string, ContextFile>();
  let completed = 0;
  const configMode = existingConfig?.mode ?? "lean";
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
          console.log(successMsg(`.context.yaml  ${dir.relativePath === "." ? "(root)" : dir.relativePath}`));
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
        process.stdout.write(`\r${progressBar(completed, dirs.length)}`);
        console.log(`\n${successMsg(`.context.yaml  ${dir.relativePath === "." ? "(root)" : dir.relativePath}`)}`);
      } catch (err) {
        completed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n${errorMsg(`${dir.relativePath}: ${msg}`)}`);
      }
    }
  }

  // Generate AGENTS.md at project root
  if (!options.noAgents) {
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

  console.log(`\n\nDone. ${completed} .context.yaml files created.`);
  printMetrics(metrics);

  // Append .autocontext/ to .gitignore if we have one — keeps the new index
  // directory from being committed by default.
  const gitignoreResult = await ensureAutocontextGitignored(rootPath);
  if (gitignoreResult.action === "appended") {
    console.log(successMsg(".autocontext/ added to .gitignore"));
  }

  // Build the local code index.
  try {
    await indexCommand({ path: rootPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(warnMsg(`code index: ${msg}`));
  }

  // Stamp semantic fingerprints into the yamls we just wrote.
  try {
    const { stampSemanticFingerprintsForDirs } = await import(
      "../core/semantic-fingerprint-writer.js"
    );
    const result = await stampSemanticFingerprintsForDirs(rootPath, dirs);
    if (result.updated > 0) {
      console.log(
        dim(`  semantic fingerprints: ${result.updated} directory${result.updated === 1 ? "" : "ies"} stamped`),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(warnMsg(`semantic fingerprints: ${msg}`));
  }

  console.log('\nRun `context status` to check freshness.\n');
}
