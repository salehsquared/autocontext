import { createHash } from "node:crypto";
import type { LLMProvider } from "../providers/index.js";
import type { ContextFile } from "../core/schema.js";
import type { ScanResult } from "../core/scanner.js";
import type { ImpactReport, ImpactSeed } from "../impact/impact.js";
import type { Violation } from "../policy/types.js";
import type { Pack } from "../pack/types.js";
import type {
  BenchTask,
  ConditionName,
  TaskResult,
  TaskResultWarning,
} from "./types.js";
import {
  BENCH_SYSTEM_PROMPT,
  buildBaselinePrompt,
  buildContextPrompt,
  buildJudgePrompt,
  buildPackImpactPrompt,
  buildPackPolicyPrompt,
  buildPackPrompt,
  buildReadmeSnippet,
} from "./prompts.js";
import { detectAbstention, scoreTask, JUDGE_SYSTEM_PROMPT } from "./scorer.js";
import { buildScopedFileTree } from "./ground-truth.js";
import { estimateInputTokens } from "./token-estimator.js";
import { DEFAULT_ARM_SET } from "./types.js";
import { buildPack } from "../pack/pack.js";
import { openReadOnlyIndex } from "../index/access.js";
import { computeImpact } from "../impact/impact.js";

export interface RunBenchOptions {
  projectRoot?: string;
  tasks: BenchTask[];
  provider: LLMProvider;
  providerName: string;
  modelName: string;
  scanResult: ScanResult;
  readme: string | null;
  contextFiles: Map<string, ContextFile>;
  iterations: number;
  armSet?: readonly ConditionName[];
  packBudget?: number;
  policyViolations?: readonly Violation[];
  onProgress?: (completed: number, total: number) => void;
}

interface ImpactContext {
  report: ImpactReport | null;
  warnings: TaskResultWarning[];
}

export async function runBench(options: RunBenchOptions): Promise<TaskResult[]> {
  const {
    projectRoot,
    tasks,
    provider,
    providerName,
    modelName,
    scanResult,
    readme,
    contextFiles,
    iterations,
    policyViolations = [],
    onProgress,
  } = options;
  const armSet = options.armSet ? [...options.armSet] : [...DEFAULT_ARM_SET];
  const readmeSnippet = buildReadmeSnippet(readme);
  const results: TaskResult[] = [];
  const totalCalls = tasks.length * iterations * armSet.length;
  let completed = 0;

  const scopeCache = new Map<string, { tree: string; scopes: string[]; resolvedScope: string }>();
  const packCache = new Map<string, Promise<Pack>>();
  const impactCache = new Map<string, Promise<ImpactContext>>();

  for (const condition of armSet) {
    for (const task of tasks) {
      for (let iter = 0; iter < iterations; iter++) {
        const start = Date.now();
        let response = "";
        let score = 0;
        let abstained = false;
        let answerInputTokensEst = 0;
        let judgeInputTokensEst = 0;
        let packCacheKey: string | undefined;
        let warnings: TaskResultWarning[] | undefined;

        try {
          const scoped = getScoped(scopeCache, task.source_scope, scanResult);
          const prompt = await buildPrompt({
            condition,
            task,
            scoped,
            readmeSnippet,
            contextFiles,
            projectRoot,
            packBudget: options.packBudget,
            policyViolations,
            packCache,
            impactCache,
          });
          warnings = prompt.warnings.length > 0 ? prompt.warnings : undefined;
          packCacheKey = prompt.packCacheKey;

          answerInputTokensEst = estimateInputTokens({
            provider: providerName,
            model: modelName,
            systemPrompt: BENCH_SYSTEM_PROMPT,
            userPrompt: prompt.userPrompt,
          });

          response = await provider.generate(BENCH_SYSTEM_PROMPT, prompt.userPrompt);
          abstained = detectAbstention(response);

          if (!abstained && task.scoring === "llm_judge") {
            const judgePrompt = buildJudgePrompt(task.question, response, task.expected);
            judgeInputTokensEst = estimateInputTokens({
              provider: providerName,
              model: modelName,
              systemPrompt: JUDGE_SYSTEM_PROMPT,
              userPrompt: judgePrompt,
            });
          }

          score = abstained
            ? 0.0
            : await scoreTask(provider, task, response);
        } catch {
          score = 0.0;
        }

        const latency = Date.now() - start;
        const totalInputTokensEst = answerInputTokensEst + judgeInputTokensEst;

        results.push({
          task_id: task.id,
          condition,
          iteration: iter,
          response,
          score,
          abstained,
          latency_ms: latency,
          answer_input_tokens_est: answerInputTokensEst,
          judge_input_tokens_est: judgeInputTokensEst,
          total_input_tokens_est: totalInputTokensEst,
          scope_tokens_est: totalInputTokensEst,
          pack_cache_key: packCacheKey,
          warnings,
        });

        completed++;
        onProgress?.(completed, totalCalls);
      }
    }
  }

  return results;
}

function getScoped(
  cache: Map<string, { tree: string; scopes: string[]; resolvedScope: string }>,
  sourceScope: string,
  scanResult: ScanResult,
): { tree: string; scopes: string[]; resolvedScope: string } {
  const cached = cache.get(sourceScope);
  if (cached) return cached;
  const computed = buildScopedFileTree(sourceScope, scanResult);
  cache.set(sourceScope, computed);
  return computed;
}

async function buildPrompt(input: {
  condition: ConditionName;
  task: BenchTask;
  scoped: { tree: string; scopes: string[]; resolvedScope: string };
  readmeSnippet: string | null;
  contextFiles: Map<string, ContextFile>;
  projectRoot?: string;
  packBudget?: number;
  policyViolations: readonly Violation[];
  packCache: Map<string, Promise<Pack>>;
  impactCache: Map<string, Promise<ImpactContext>>;
}): Promise<{ userPrompt: string; packCacheKey?: string; warnings: TaskResultWarning[] }> {
  const {
    condition,
    task,
    scoped,
    readmeSnippet,
    contextFiles,
    projectRoot,
    packBudget,
    policyViolations,
    packCache,
    impactCache,
  } = input;

  if (condition === "baseline") {
    return {
      userPrompt: buildBaselinePrompt(scoped.tree, readmeSnippet, task.question, scoped.resolvedScope),
      warnings: [],
    };
  }

  if (condition === "context") {
    const scopedContexts = new Map<string, ContextFile>();
    for (const scope of scoped.scopes) {
      const ctx = contextFiles.get(scope);
      if (ctx) scopedContexts.set(scope, ctx);
    }
    return {
      userPrompt: buildContextPrompt(scoped.tree, scopedContexts, task.question, scoped.resolvedScope),
      warnings: [],
    };
  }

  const pack = await getPackForTask(task, projectRoot, packBudget, packCache);
  const packCacheKey = makePackCacheKey(pack);

  if (condition === "pack") {
    return {
      userPrompt: buildPackPrompt(pack, task.question, scoped.resolvedScope),
      packCacheKey,
      warnings: [],
    };
  }

  if (condition === "pack+impact") {
    const impact = await getImpactForTask(task, projectRoot, impactCache);
    return {
      userPrompt: buildPackImpactPrompt(pack, impact.report, task.question, scoped.resolvedScope),
      packCacheKey,
      warnings: impact.warnings,
    };
  }

  const violations = filterViolationsForPack(pack, policyViolations);
  return {
    userPrompt: buildPackPolicyPrompt(pack, violations, task.question, scoped.resolvedScope),
    packCacheKey,
    warnings: [],
  };
}

async function getPackForTask(
  task: BenchTask,
  projectRoot: string | undefined,
  packBudget: number | undefined,
  cache: Map<string, Promise<Pack>>,
): Promise<Pack> {
  if (!projectRoot) {
    throw new Error("runBench requires projectRoot when pack arms are selected.");
  }

  const key = `${task.id}\u0000${packBudget ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const next = buildPack({
    projectRoot,
    budget: packBudget,
    ...(task.task_seed?.kind === "file"
      ? { file: task.task_seed.value }
      : task.task_seed?.kind === "symbol"
        ? { symbol: task.task_seed.value }
        : { query: task.task_seed?.value ?? task.question }),
  });
  cache.set(key, next);
  return next;
}

async function getImpactForTask(
  task: BenchTask,
  projectRoot: string | undefined,
  cache: Map<string, Promise<ImpactContext>>,
): Promise<ImpactContext> {
  if (!projectRoot) {
    return {
      report: null,
      warnings: [{ kind: "impact_seed_unavailable", detail: "project_root_missing" }],
    };
  }

  const cached = cache.get(task.id);
  if (cached) return cached;

  const next = computeImpactForTask(task, projectRoot);
  cache.set(task.id, next);
  return next;
}

async function computeImpactForTask(task: BenchTask, projectRoot: string): Promise<ImpactContext> {
  if (!task.task_seed || task.task_seed.kind === "query") {
    return {
      report: null,
      warnings: [{ kind: "impact_seed_unavailable" }],
    };
  }

  const access = await openReadOnlyIndex(projectRoot);
  if (access.state !== "ready") {
    return {
      report: null,
      warnings: [{ kind: "impact_index_unavailable", detail: access.state }],
    };
  }

  const store = access.store;
  try {
    let seeds: ImpactSeed[] = [];
    if (task.task_seed.kind === "file") {
      seeds = [{ file: task.task_seed.value, reason: "file" }];
    } else if (task.task_seed.kind === "symbol") {
      const matches = await store.findSymbolsByName(task.task_seed.value);
      if (matches.length === 0) {
        return {
          report: null,
          warnings: [{ kind: "impact_seed_unresolved", detail: task.task_seed.value }],
        };
      }
      seeds = matches.map((match) => ({
        file: match.file,
        symbol: match.name,
        reason: "symbol",
      }));
    }

    if (seeds.length === 0) {
      return {
        report: null,
        warnings: [{ kind: "impact_seed_unavailable" }],
      };
    }

    return {
      report: await computeImpact(store, seeds, {}),
      warnings: [],
    };
  } finally {
    await store.close();
  }
}

function filterViolationsForPack(pack: Pack, violations: readonly Violation[]): Violation[] {
  const admittedScopes = pack.scopes.map((scope) => scope.scope);
  if (admittedScopes.length === 0 || violations.length === 0) return [];

  return violations.filter((violation) => {
    return admittedScopes.some((scope) =>
      scopesOverlap(scope, violation.scope)
      || (violation.file ? fileMatchesScope(violation.file, scope) : false),
    );
  });
}

function scopesOverlap(left: string, right: string): boolean {
  if (left === "." || right === ".") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function fileMatchesScope(file: string, scope: string): boolean {
  if (scope === ".") return true;
  return file === scope || file.startsWith(`${scope}/`);
}

function makePackCacheKey(pack: Pack): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      seed: pack.seed,
      budget: pack.budget,
      scopes: pack.scopes.map((scope) => scope.scope),
    }))
    .digest("hex");
  return digest.slice(0, 16);
}
