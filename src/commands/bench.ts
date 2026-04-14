import { resolve, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { checkFreshness, legacyState } from "../core/fingerprint.js";
import { createProvider } from "../providers/index.js";
import { loadConfig, resolveApiKey } from "../utils/config.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { heading, dim, errorMsg, warnMsg, progressBar } from "../utils/display.js";
import type { ContextFile } from "../core/schema.js";
import {
  ARMS,
  DEFAULT_ARM_SET,
  type BenchOptions,
  type BenchReport,
  type ConditionName,
  type MultiRepoReport,
  type TaskCategory,
} from "../bench/types.js";
import {
  buildDepSets,
  buildReverseDeps,
  buildDirFacts,
} from "../bench/ground-truth.js";
import { generateSymbolTasks } from "../bench/ground-truth-symbols.js";
import { generateImpactTasks } from "../bench/ground-truth-impact.js";
import { isGitRepo, getFixCommits, getFeatureCommits } from "../bench/git.js";
import { generateTasks, limitTasks } from "../bench/tasks.js";
import { runBench } from "../bench/runner.js";
import { aggregateResults, aggregateMultiRepo } from "../bench/scorer.js";
import { DEFAULT_REPOS, cleanupRepos } from "../bench/repos.js";
import { cloneRepo } from "../bench/git.js";
import { buildProvenance, IMPACT_VERSION, PACK_BUDGET_DEFAULT } from "../bench/provenance.js";
import { openReadOnlyIndex } from "../index/access.js";
import { runPolicies } from "../policy/engine.js";
import type { Violation } from "../policy/types.js";
import { initCommand } from "./init.js";

const INDEX_BACKED_CATEGORIES = new Set([
  "find-definition",
  "find-callers",
  "impact-of-change",
] as const);

const INDEX_REQUIRED_ARMS = new Set<ConditionName>(["pack+impact", "pack+policy"]);

export async function benchCommand(options: BenchOptions): Promise<void> {
  const configRootPath = resolve(options.path ?? ".");

  // Multi-repo mode
  if (options.defaultRepos) {
    await runMultiRepo(options, configRootPath);
    return;
  }

  // Single repo mode (local or --repo)
  let rootPath = configRootPath;
  let tempDir: string | null = null;

  if (options.repo) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    tempDir = await mkdtemp(join(tmpdir(), "autocontext-bench-"));
    console.log(dim(`  cloning ${options.repo}...`));
    await cloneRepo(options.repo, tempDir, 100);
    rootPath = tempDir;

    console.log(dim("  running context init..."));
    await initCommand({ path: rootPath, noLlm: true, noAgents: true });
  }

  try {
    const report = await runSingleBench(rootPath, options, configRootPath);

    if (options.json) {
      const json = JSON.stringify(report, null, 2) + "\n";
      if (options.out) {
        await writeFile(options.out, json, "utf-8");
        console.log(dim(`  report written to ${options.out}`));
      } else {
        process.stdout.write(json);
      }
      return;
    }

    printReport(report);

    if (options.out) {
      await writeFile(options.out, JSON.stringify(report, null, 2) + "\n", "utf-8");
      console.log(dim(`\n  JSON report written to ${options.out}`));
    }
  } finally {
    if (tempDir) {
      await cleanupRepos([tempDir]);
    }
  }
}

async function runSingleBench(
  rootPath: string,
  options: BenchOptions,
  configRootPath: string = rootPath,
): Promise<BenchReport> {
  const config = await loadConfig(configRootPath);
  if (!config?.provider) {
    console.error(errorMsg("No provider configured. Run `context config --provider <name>` first."));
    process.exitCode = 1;
    throw new Error("No provider configured");
  }

  const apiKey = resolveApiKey(config);
  if (!apiKey && config.provider !== "ollama") {
    console.error(errorMsg(`No API key found. Set ${config.api_key_env ?? "ANTHROPIC_API_KEY"} environment variable.`));
    process.exitCode = 1;
    throw new Error("No API key");
  }

  const provider = await createProvider(config.provider, apiKey, config.model);
  const modelName = config.model ?? config.provider;
  const armSet = parseArmSet(options.arm);
  const packBudget = resolvePackBudget(options.packBudget);
  const seed = options.seed ?? 42;
  const iterations = options.iterations ?? 1;

  // Scan project
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);

  // Collect context files and check freshness
  const contextFiles = new Map<string, ContextFile>();
  let staleCount = 0;

  for (const dir of allDirs) {
    let ctx;
    try {
      ctx = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        if (!options.json) console.error(warnMsg(`${dir.relativePath}: ${err.message}`));
        ctx = null;
      } else {
        throw err;
      }
    }
    if (ctx) {
      contextFiles.set(dir.relativePath, ctx);

      if (!options.allowStale) {
        const { state } = await checkFreshness(dir.path, ctx.fingerprint);
        if (legacyState(state) === "stale") staleCount++;
      }
    }
  }

  if (contextFiles.size === 0) {
    console.error(errorMsg("No .context.yaml files found. Run `context init` first."));
    process.exitCode = 1;
    throw new Error("No context files");
  }

  if (staleCount > 0 && !options.allowStale) {
    console.error(errorMsg(`${staleCount} context file(s) are stale. Run \`context regen --stale\` or pass --allow-stale.`));
    process.exitCode = 1;
    throw new Error("Stale contexts");
  }

  const wantsLegacyTasks = shouldGenerateLegacyTasks(options.category);
  const wantsIndexTasks = shouldGenerateIndexTasks(options.category);
  const requestedIndexCategory =
    options.category !== undefined && shouldGenerateIndexTasks(options.category) && !shouldGenerateLegacyTasks(options.category);

  let legacyTasks: Awaited<ReturnType<typeof generateTasks>> = [];
  if (wantsLegacyTasks) {
    const [depSets, reverseDeps, dirFacts] = await Promise.all([
      buildDepSets(scanResult),
      buildReverseDeps(scanResult),
      buildDirFacts(scanResult),
    ]);

    const hasGit = isGitRepo(rootPath);
    const fixCommits = hasGit ? getFixCommits(rootPath, 10) : [];
    const featureCommits = hasGit ? getFeatureCommits(rootPath, 10) : [];

    if (!hasGit && !options.json) {
      console.log(dim("  not a git repo — skipping bug_localization and patch_planning\n"));
    }

    legacyTasks = await generateTasks({
      scanResult,
      dirFacts,
      depSets,
      reverseDeps,
      fixCommits,
      featureCommits,
      category: options.category,
      seed,
    });
  }

  const needsIndex = wantsIndexTasks || armSet.some((arm) => INDEX_REQUIRED_ARMS.has(arm));
  let indexTasks: Awaited<ReturnType<typeof generateTasks>> = [];
  if (needsIndex) {
    const access = await openReadOnlyIndex(rootPath);
    if (access.state !== "ready") {
      if (armSet.some((arm) => INDEX_REQUIRED_ARMS.has(arm))) {
        failIndexRequired(
          `Selected arm(s) require a usable code index: ${armSet.filter((arm) => INDEX_REQUIRED_ARMS.has(arm)).join(", ")}.`,
          access.state,
        );
      }
      if (requestedIndexCategory) {
        failIndexRequired(
          `Task category ${options.category} requires a usable code index.`,
          access.state,
        );
      }
    } else {
      const store = access.store;
      try {
        const [{ findDefinitionTasks, findCallersTasks }, impactTasks] = await Promise.all([
          generateSymbolTasks({
            index: store,
            indexVersion: store.manifest.index_version,
            seed,
          }),
          generateImpactTasks({
            index: store,
            indexVersion: store.manifest.index_version,
            impactVersion: IMPACT_VERSION,
            seed,
          }),
        ]);

        if (!options.category || options.category === "find-definition") {
          indexTasks.push(...findDefinitionTasks);
        }
        if (!options.category || options.category === "find-callers") {
          indexTasks.push(...findCallersTasks);
        }
        if (!options.category || options.category === "impact-of-change") {
          indexTasks.push(...impactTasks);
        }
      } finally {
        await store.close();
      }
    }
  }

  let tasks = [...legacyTasks, ...indexTasks];
  if (options.maxTasks && tasks.length > options.maxTasks) {
    tasks = limitTasks(tasks, options.maxTasks, seed);
  }

  if (tasks.length === 0) {
    console.error(errorMsg("No tasks generated. Need files with exports, dependencies, or git history."));
    process.exitCode = 1;
    throw new Error("No tasks");
  }

  // Read README for baseline context
  let readme: string | null = null;
  try {
    readme = await readFile(join(rootPath, "README.md"), "utf-8");
  } catch { /* no readme */ }

  // Pre-run summary
  if (!options.json) {
    console.log("");
    console.log(`  provider: ${config.provider} (${modelName})`);
    console.log(`  tasks: ${tasks.length}  iterations: ${iterations}  seed: ${seed}`);
    console.log(`  arms: ${armSet.join(", ")}\n`);
  }

  let policyViolations: Violation[] = [];
  if (armSet.includes("pack+policy")) {
    const policyRun = await runPolicies({ projectRoot: rootPath });
    if (policyRun.index_state !== "ready") {
      failIndexRequired("pack+policy requires a usable code index.", policyRun.index_state);
    }
    policyViolations = policyRun.violations;
  }

  const categorySet = [...new Set(tasks.map((task) => task.category))].sort() as TaskCategory[];
  const provenance = await buildProvenance({
    projectRoot: rootPath,
    seed,
    iterations,
    armSet,
    categorySet,
    provider: config.provider,
    model: modelName,
    packBudgetDefault: packBudget,
  });

  // Run benchmark
  const results = await runBench({
    projectRoot: rootPath,
    tasks,
    provider,
    providerName: config.provider,
    modelName,
    scanResult,
    readme,
    contextFiles,
    iterations,
    armSet,
    packBudget,
    policyViolations,
    onProgress: options.json
      ? undefined
      : (completed, total) => {
          process.stdout.write(`\r${progressBar(completed, total)}`);
        },
  });

  if (!options.json) {
    process.stdout.write("\r" + " ".repeat(60) + "\r");
  }

  return aggregateResults(
    rootPath,
    config.provider,
    modelName,
    iterations,
    seed,
    tasks,
    results,
    options.repo,
    { armSet, provenance },
  );
}

async function runMultiRepo(options: BenchOptions, configRootPath: string): Promise<void> {
  const config = await loadConfig(configRootPath);
  if (!config?.provider) {
    console.error(errorMsg("No provider configured. Run `context config --provider <name>` first."));
    process.exitCode = 1;
    return;
  }

  const apiKey = resolveApiKey(config);
  if (!apiKey && config.provider !== "ollama") {
    console.error(errorMsg(`No API key found. Set ${config.api_key_env ?? "ANTHROPIC_API_KEY"} environment variable.`));
    process.exitCode = 1;
    return;
  }

  const modelName = config.model ?? config.provider;
  const tempDirs: string[] = [];
  const reports: BenchReport[] = [];

  if (!options.json) {
    console.log("");
    console.log(`  provider: ${config.provider} (${modelName})`);
    console.log(`  repos: ${DEFAULT_REPOS.length}  iterations: ${options.iterations ?? 1}\n`);
  }

  for (let i = 0; i < DEFAULT_REPOS.length; i++) {
    const repo = DEFAULT_REPOS[i];
    if (!options.json) {
      process.stdout.write(`  [${i + 1}/${DEFAULT_REPOS.length}] ${repo.url.replace("https://github.com/", "")}  `);
    }

    try {
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const tempDir = await mkdtemp(join(tmpdir(), `autocontext-bench-${repo.name}-`));
      tempDirs.push(tempDir);

      if (!options.json) process.stdout.write("cloning... ");
      await cloneRepo(repo.url, tempDir, 100);

      if (!options.json) process.stdout.write("init... ");
      await initCommand({ path: tempDir, noLlm: true, noAgents: true });

      if (!options.json) process.stdout.write("benchmarking...\n");
      const report = await runSingleBench(tempDir, {
        ...options,
        path: tempDir,
        json: true, // suppress inner output
        repo: repo.url,
      }, configRootPath);
      reports.push(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!options.json) {
        console.log(errorMsg(`failed: ${msg}`));
      }
    }
  }

  // Cleanup
  await cleanupRepos(tempDirs);

  if (reports.length === 0) {
    console.error(errorMsg("All repos failed. Check your network and API key."));
    process.exitCode = 1;
    return;
  }

  const multiReport = aggregateMultiRepo(reports, config.provider, modelName);

  if (options.json) {
    const json = JSON.stringify(multiReport, null, 2) + "\n";
    if (options.out) {
      await writeFile(options.out, json, "utf-8");
    } else {
      process.stdout.write(json);
    }
    return;
  }

  printMultiRepoReport(multiReport);

  if (options.out) {
    await writeFile(options.out, JSON.stringify(multiReport, null, 2) + "\n", "utf-8");
    console.log(dim(`\n  JSON report written to ${options.out}`));
  }
}

function printReport(report: BenchReport): void {
  const b = report.baseline;
  const c = report.context;
  const d = report.delta;

  console.log("");
  console.log(heading("  Results"));
  console.log("  " + "─".repeat(54));

  const fmtScore = (s: number, sd: number) =>
    `${s.toFixed(2)}±${sd.toFixed(2)}`;
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const fmtTokens = (n: number) =>
    n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`;
  const fmtDelta = (n: number) =>
    n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  const fmtDeltaPct = (n: number) =>
    `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  const fmtDeltaPp = (n: number) =>
    `${n >= 0 ? "-" : "+"}${(Math.abs(n) * 100).toFixed(1)}pp`;
  const fmtTokenDelta = (baseline: number, context: number) => {
    if (baseline <= 0) return "n/a".padStart(10);
    return pad(fmtDeltaPct(context / baseline - 1), 10);
  };

  const pad = (s: string, w: number) => s.padStart(w);

  console.log(
    `${"".padStart(22)}${pad("baseline", 12)}${pad("context", 12)}${pad("delta", 10)}`,
  );
  console.log(
    `  ${"accuracy".padEnd(20)}${pad(fmtScore(b.mean_score, b.stddev_score), 12)}${pad(fmtScore(c.mean_score, c.stddev_score), 12)}${pad(fmtDelta(d.accuracy_gain), 10)}`,
  );
  console.log(
    `  ${"abstentions".padEnd(20)}${pad(fmtPct(b.abstention_rate), 12)}${pad(fmtPct(c.abstention_rate), 12)}${pad(fmtDeltaPp(d.abstention_reduction), 10)}`,
  );
  console.log(
    `  ${"answer in (est)".padEnd(20)}${pad(fmtTokens(b.total_answer_tokens_est), 12)}${pad(fmtTokens(c.total_answer_tokens_est), 12)}${fmtTokenDelta(b.total_answer_tokens_est, c.total_answer_tokens_est)}`,
  );
  if (b.total_judge_tokens_est > 0 || c.total_judge_tokens_est > 0) {
    console.log(
      `  ${"judge in (est)".padEnd(20)}${pad(fmtTokens(b.total_judge_tokens_est), 12)}${pad(fmtTokens(c.total_judge_tokens_est), 12)}${fmtTokenDelta(b.total_judge_tokens_est, c.total_judge_tokens_est)}`,
    );
  }
  console.log(
    `  ${"total in (est)".padEnd(20)}${pad(fmtTokens(b.total_tokens_est), 12)}${pad(fmtTokens(c.total_tokens_est), 12)}${pad(fmtDeltaPct(-d.token_reduction), 10)}`,
  );
  console.log(
    `  ${"avg latency".padEnd(20)}${pad(`${(b.mean_latency_ms / 1000).toFixed(1)}s`, 12)}${pad(`${(c.mean_latency_ms / 1000).toFixed(1)}s`, 12)}`,
  );

  if (isFinite(b.cost_per_correct) && isFinite(c.cost_per_correct)) {
    console.log(
      `  ${"cost/correct".padEnd(20)}${pad(`${fmtTokens(b.cost_per_correct)} tok`, 12)}${pad(`${fmtTokens(c.cost_per_correct)} tok`, 12)}${pad(fmtDeltaPct(-d.cost_per_correct_reduction), 10)}`,
    );
  }

  // Category breakdown
  const categories = Object.keys(b.by_category);
  if (categories.length > 0) {
    console.log("");
    console.log(heading("  By Category"));
    console.log("  " + "─".repeat(54));
    for (const cat of categories) {
      const bCat = b.by_category[cat];
      const cCat = c.by_category[cat];
      if (!bCat || !cCat) continue;
      const delta = cCat.mean_score - bCat.mean_score;
      console.log(
        `  ${cat.padEnd(20)}${bCat.mean_score.toFixed(2)}  →  ${cCat.mean_score.toFixed(2)}    ${fmtDelta(delta)}  (${bCat.count} tasks)`,
      );
    }
  }

  const totalCalls = report.results.length;
  const totalTime = report.results.reduce((a, r) => a + r.latency_ms, 0);
  console.log("");
  console.log(
    `  ${report.task_count} tasks, ${totalCalls} LLM calls completed in ${(totalTime / 1000).toFixed(1)}s`,
  );
  console.log(
    `  .context.yaml improved accuracy by ${fmtDelta(d.accuracy_gain).replace("+", "+")}pp, reduced abstentions by ${(d.abstention_reduction * 100).toFixed(0)}pp`,
  );
  console.log("");
}

function printMultiRepoReport(report: MultiRepoReport): void {
  const agg = report.aggregate;

  console.log("");
  console.log(heading("  Cross-Repo Results"));
  console.log("  " + "─".repeat(62));
  console.log(
    `  ${"repo".padEnd(22)}${"baseline".padStart(12)}${"context".padStart(12)}${"delta".padStart(10)}`,
  );

  for (const repo of report.repos) {
    const name = (repo.repo ?? repo.root).replace("https://github.com/", "");
    const shortName = name.length > 20 ? name.slice(0, 20) : name;
    console.log(
      `  ${shortName.padEnd(22)}${repo.baseline.mean_score.toFixed(2).padStart(12)}${repo.context.mean_score.toFixed(2).padStart(12)}${("+" + repo.delta.accuracy_gain.toFixed(2)).padStart(10)}`,
    );
  }

  console.log(
    `\n  ${"aggregate".padEnd(22)}${agg.baseline_mean.toFixed(2).padStart(12)}${agg.context_mean.toFixed(2).padStart(12)}${("+" + agg.accuracy_gain.toFixed(2)).padStart(10)}`,
  );

  // Category breakdown
  const categories = Object.keys(agg.by_category);
  if (categories.length > 0) {
    console.log("");
    console.log(heading("  By Category (aggregate)"));
    console.log("  " + "─".repeat(62));
    for (const cat of categories) {
      const data = agg.by_category[cat];
      console.log(
        `  ${cat.padEnd(20)}${data.baseline.toFixed(2)}  →  ${data.context.toFixed(2)}    +${data.delta.toFixed(2)}`,
      );
    }
  }

  const totalTasks = report.repos.reduce((a: number, r: BenchReport) => a + r.task_count, 0);
  const totalCalls = report.repos.reduce((a: number, r: BenchReport) => a + r.results.length, 0);
  const totalTime = report.repos.reduce(
    (a: number, r: BenchReport) => a + r.results.reduce((b, res) => b + res.latency_ms, 0),
    0,
  );
  console.log("");
  console.log(
    `  ${report.repos.length} repos, ~${totalTasks} tasks, ~${totalCalls} LLM calls completed in ${(totalTime / 1000 / 60).toFixed(0)}m ${((totalTime / 1000) % 60).toFixed(0)}s`,
  );
  console.log("");
}

function parseArmSet(raw?: string): ConditionName[] {
  if (!raw) return [...DEFAULT_ARM_SET];
  const selected = new Set(
    raw.split(",").map((part) => part.trim()).filter(Boolean),
  );
  if (selected.size === 0) {
    failUsage("`--arm` must include at least one arm.");
  }

  const invalid = [...selected].filter((arm) => !ARMS.includes(arm as ConditionName));
  if (invalid.length > 0) {
    failUsage(`Unknown bench arm(s): ${invalid.join(", ")}. Valid arms: ${ARMS.join(", ")}.`);
  }

  return ARMS.filter((arm) => selected.has(arm));
}

function resolvePackBudget(raw?: number): number {
  if (raw === undefined) return PACK_BUDGET_DEFAULT;
  if (!Number.isInteger(raw) || raw <= 0) {
    failUsage("`--pack-budget` must be a positive integer.");
  }
  return raw;
}

function shouldGenerateIndexTasks(category?: BenchOptions["category"]): boolean {
  return category === undefined || INDEX_BACKED_CATEGORIES.has(category as typeof INDEX_BACKED_CATEGORIES extends Set<infer T> ? T : never);
}

function shouldGenerateLegacyTasks(category?: BenchOptions["category"]): boolean {
  return category === undefined || !INDEX_BACKED_CATEGORIES.has(category as typeof INDEX_BACKED_CATEGORIES extends Set<infer T> ? T : never);
}

function failIndexRequired(prefix: string, state: "missing" | "stale"): never {
  const remediation = state === "stale"
    ? "Run `context index --rebuild` (or `context index` if only sources changed) and retry."
    : "Run `context index` and retry.";
  console.error(errorMsg(`${prefix} ${remediation}`));
  process.exitCode = 2;
  throw new Error(`Bench index ${state}`);
}

function failUsage(message: string): never {
  console.error(errorMsg(message));
  process.exitCode = 2;
  throw new Error(message);
}
