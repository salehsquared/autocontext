import type { LLMProvider } from "../providers/index.js";
import type {
  BenchTask,
  TaskResult,
  ConditionSummary,
  ConditionName,
  BenchReport,
  BenchProvenance,
  MultiRepoReport,
} from "./types.js";
import { buildJudgePrompt } from "./prompts.js";

export const JUDGE_SYSTEM_PROMPT =
  "You are a precise evaluator. Respond with ONLY a single digit: 0, 1, 2, or 3.";

const ABSTENTION_PATTERNS = [
  /\bi don'?t know\b/i,
  /\bnot sure\b/i,
  /\bcannot determine\b/i,
  /\bno information\b/i,
  /\bunable to answer\b/i,
  /\binsufficient information\b/i,
  /\bcannot answer\b/i,
  /\bdon'?t have enough\b/i,
];

export function detectAbstention(response: string): boolean {
  return ABSTENTION_PATTERNS.some((p) => p.test(response));
}

export function scoreListCoverage(response: string, expected: string[]): number {
  if (expected.length === 0) return 1.0;
  const lower = response.toLowerCase();
  let hits = 0;
  for (const item of expected) {
    if (lower.includes(item.toLowerCase())) {
      hits++;
    }
  }
  return hits / expected.length;
}

export function scoreTopkRecall(response: string, expected: string[]): number {
  if (expected.length === 0) return 1.0;
  const lower = response.toLowerCase();
  let found = 0;
  for (const item of expected) {
    if (lower.includes(item.toLowerCase())) {
      found++;
    }
  }
  return found / expected.length;
}

export function scoreTargetHit(response: string, expected: string[]): number {
  const lower = response.toLowerCase();
  for (const target of expected) {
    if (lower.includes(target.toLowerCase())) {
      return 1.0;
    }
  }
  return 0.0;
}

function extractPaths(text: string): string[] {
  // Match file-path-like strings: at least one slash or dot-separated with extension
  const pathPattern = /(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|md|yaml|yml|json|toml|cfg)/g;
  const matches = text.match(pathPattern);
  return matches ?? [];
}

export function scoreMrr(response: string, expected: string[]): number {
  if (expected.length === 0) return 1.0;
  const paths = extractPaths(response);
  const expectedLower = new Set(expected.map((e) => e.toLowerCase()));

  for (let i = 0; i < paths.length; i++) {
    if (expectedLower.has(paths[i].toLowerCase())) {
      return 1.0 / (i + 1);
    }
  }
  return 0.0;
}

export function scoreFileSetF1(response: string, expected: string[]): number {
  if (expected.length === 0) return 1.0;
  const predicted = extractPaths(response);
  if (predicted.length === 0) return 0.0;

  const expectedLower = new Set(expected.map((e) => e.toLowerCase()));
  const predictedLower = [...new Set(predicted.map((p) => p.toLowerCase()))];

  let correct = 0;
  for (const p of predictedLower) {
    if (expectedLower.has(p)) {
      correct++;
    }
  }

  if (correct === 0) return 0.0;

  const precision = correct / predictedLower.length;
  const recall = correct / expected.length;
  return (2 * precision * recall) / (precision + recall);
}

export async function scoreLlmJudge(
  provider: LLMProvider,
  question: string,
  response: string,
  referenceFacts: string[],
): Promise<number> {
  const prompt = buildJudgePrompt(question, response, referenceFacts);
  try {
    const result = await provider.generate(JUDGE_SYSTEM_PROMPT, prompt);
    const digit = result.trim().match(/^[0-3]/);
    if (!digit) return 0.0;
    return parseInt(digit[0]) / 3.0;
  } catch {
    return 0.0;
  }
}

export async function scoreTask(
  provider: LLMProvider | null,
  task: BenchTask,
  response: string,
): Promise<number> {
  switch (task.scoring) {
    case "llm_judge":
      if (!provider) return 0.0;
      return scoreLlmJudge(provider, task.question, response, task.expected);
    case "list_coverage":
      return scoreListCoverage(response, task.expected);
    case "topk_recall":
      return scoreTopkRecall(response, task.expected);
    case "target_hit":
      return scoreTargetHit(response, task.expected);
    case "mrr":
      return scoreMrr(response, task.expected);
    case "file_set_f1":
      return scoreFileSetF1(response, task.expected);
    default:
      return 0.0;
  }
}

function computeStddev(scores: number[]): number {
  if (scores.length === 0) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

function summarizeCondition(
  condition: ConditionName,
  results: TaskResult[],
  tasks: BenchTask[],
): ConditionSummary {
  const conditionResults = results.filter((r) => r.condition === condition);
  const scores = conditionResults.map((r) => r.score);
  const taskCount = conditionResults.length;

  const meanScore =
    taskCount > 0 ? scores.reduce((a, b) => a + b, 0) / taskCount : 0;
  const abstentionCount = conditionResults.filter((r) => r.abstained).length;
  const totalLatency = conditionResults.reduce((a, r) => a + r.latency_ms, 0);
  const totalAnswerTokens = conditionResults.reduce(
    (a, r) => a + (r.answer_input_tokens_est ?? 0),
    0,
  );
  const totalJudgeTokens = conditionResults.reduce(
    (a, r) => a + (r.judge_input_tokens_est ?? 0),
    0,
  );
  const totalTokens = conditionResults.reduce((a, r) => {
    if (typeof r.total_input_tokens_est === "number") return a + r.total_input_tokens_est;
    if (typeof r.scope_tokens_est === "number") return a + r.scope_tokens_est;
    return a + (r.answer_input_tokens_est ?? 0) + (r.judge_input_tokens_est ?? 0);
  }, 0);
  const correctCount = conditionResults.filter((r) => r.score >= 0.7).length;

  // Build category breakdown
  const byCategory: Record<string, { count: number; mean_score: number }> = {};
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const categoryScores: Record<string, number[]> = {};

  for (const r of conditionResults) {
    const task = taskMap.get(r.task_id);
    if (!task) continue;
    if (!categoryScores[task.category]) {
      categoryScores[task.category] = [];
    }
    categoryScores[task.category].push(r.score);
  }

  for (const [cat, catScores] of Object.entries(categoryScores)) {
    byCategory[cat] = {
      count: catScores.length,
      mean_score: catScores.reduce((a, b) => a + b, 0) / catScores.length,
    };
  }

  return {
    condition,
    tasks_run: taskCount,
    mean_score: meanScore,
    stddev_score: computeStddev(scores),
    abstention_rate: taskCount > 0 ? abstentionCount / taskCount : 0,
    mean_latency_ms: taskCount > 0 ? totalLatency / taskCount : 0,
    total_answer_tokens_est: totalAnswerTokens,
    total_judge_tokens_est: totalJudgeTokens,
    total_tokens_est: totalTokens,
    cost_per_correct: correctCount > 0 ? totalTokens / correctCount : Infinity,
    by_category: byCategory,
  };
}

export function aggregateResults(
  rootPath: string,
  provider: string,
  model: string,
  iterations: number,
  seed: number,
  tasks: BenchTask[],
  results: TaskResult[],
  repo?: string,
  opts?: {
    armSet?: readonly import("./types.js").ConditionName[];
    provenance?: BenchProvenance;
  },
): BenchReport {
  const baseline = summarizeCondition("baseline", results, tasks);
  const context = summarizeCondition("context", results, tasks);

  const tokenReduction =
    baseline.total_tokens_est > 0
      ? 1 - context.total_tokens_est / baseline.total_tokens_est
      : 0;

  const costReduction =
    baseline.cost_per_correct > 0 && isFinite(baseline.cost_per_correct)
      ? 1 - context.cost_per_correct / baseline.cost_per_correct
      : 0;

  // Per-arm summaries (T12). Build from the full ARMS list; only arms with
  // results get non-empty summaries.
  const observedArms = new Set(results.map((r) => r.condition));
  const armList = opts?.armSet && opts.armSet.length > 0
    ? opts.armSet
    : (Array.from(observedArms) as import("./types.js").ConditionName[]);
  const arms: Partial<Record<import("./types.js").ConditionName, import("./types.js").ConditionSummary>> = {};
  for (const arm of armList) {
    arms[arm] = summarizeCondition(arm, results, tasks);
  }

  // Per-arm × per-category matrix.
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const matrix: Partial<Record<import("./types.js").ConditionName, Record<string, import("./types.js").ArmCellStats>>> = {};
  const cellScores = new Map<string, number[]>();
  const cellLatencies = new Map<string, number[]>();
  const cellTokens = new Map<string, number[]>();
  for (const r of results) {
    const task = taskMap.get(r.task_id);
    if (!task) continue;
    const key = `${r.condition}\u0000${task.category}`;
    const s = cellScores.get(key) ?? [];
    s.push(r.score);
    cellScores.set(key, s);
    const l = cellLatencies.get(key) ?? [];
    l.push(r.latency_ms);
    cellLatencies.set(key, l);
    const t = cellTokens.get(key) ?? [];
    const tokens = typeof r.total_input_tokens_est === "number"
      ? r.total_input_tokens_est
      : (r.answer_input_tokens_est ?? 0) + (r.judge_input_tokens_est ?? 0);
    t.push(tokens);
    cellTokens.set(key, t);
  }
  for (const [key, scores] of cellScores) {
    const [arm, category] = key.split("\u0000") as [import("./types.js").ConditionName, string];
    const lat = cellLatencies.get(key) ?? [];
    const tok = cellTokens.get(key) ?? [];
    const perArm = matrix[arm] ?? {};
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    perArm[category] = {
      count: scores.length,
      mean_score: mean,
      stddev_score: computeStddev(scores),
      mean_latency_ms: lat.length > 0 ? lat.reduce((a, b) => a + b, 0) / lat.length : 0,
      mean_tokens: tok.length > 0 ? tok.reduce((a, b) => a + b, 0) / tok.length : 0,
    };
    matrix[arm] = perArm;
  }

  // Arm deltas vs the `context` arm. (A cross-cut: most consumers care
  // "did the new arm beat the existing authored-context arm?")
  const armDeltas: Partial<Record<Exclude<import("./types.js").ConditionName, "context">, import("./types.js").ArmDelta>> = {};
  for (const [armName, summary] of Object.entries(arms)) {
    if (armName === "context" || !summary) continue;
    const tokReduce = summary.total_tokens_est > 0
      ? 1 - context.total_tokens_est / summary.total_tokens_est
      : 0;
    const costReduce = summary.cost_per_correct > 0 && isFinite(summary.cost_per_correct)
      ? 1 - context.cost_per_correct / summary.cost_per_correct
      : 0;
    armDeltas[armName as Exclude<import("./types.js").ConditionName, "context">] = {
      accuracy_gain: summary.mean_score - context.mean_score,
      abstention_reduction: context.abstention_rate - summary.abstention_rate,
      token_reduction: tokReduce,
      cost_per_correct_reduction: costReduce,
    };
  }

  return {
    root: rootPath,
    repo,
    provider,
    model,
    iterations,
    seed,
    timestamp: new Date().toISOString(),
    task_count: tasks.length,
    baseline,
    context,
    delta: {
      accuracy_gain: context.mean_score - baseline.mean_score,
      abstention_reduction:
        baseline.abstention_rate - context.abstention_rate,
      token_reduction: tokenReduction,
      cost_per_correct_reduction: costReduction,
    },
    tasks,
    results,
    arms,
    matrix,
    arm_deltas: armDeltas,
    provenance: opts?.provenance,
  };
}

export function aggregateMultiRepo(
  reports: BenchReport[],
  provider: string,
  model: string,
): MultiRepoReport {
  const baselineMeans = reports.map((r) => r.baseline.mean_score);
  const contextMeans = reports.map((r) => r.context.mean_score);

  const baselineMean =
    baselineMeans.reduce((a, b) => a + b, 0) / baselineMeans.length;
  const contextMean =
    contextMeans.reduce((a, b) => a + b, 0) / contextMeans.length;

  // Aggregate by category across repos
  const byCategory: Record<
    string,
    { baseline: number; context: number; delta: number }
  > = {};
  const categoryBaselines: Record<string, number[]> = {};
  const categoryContexts: Record<string, number[]> = {};

  for (const report of reports) {
    for (const [cat, data] of Object.entries(report.baseline.by_category)) {
      if (!categoryBaselines[cat]) categoryBaselines[cat] = [];
      categoryBaselines[cat].push(data.mean_score);
    }
    for (const [cat, data] of Object.entries(report.context.by_category)) {
      if (!categoryContexts[cat]) categoryContexts[cat] = [];
      categoryContexts[cat].push(data.mean_score);
    }
  }

  const allCategories = new Set([
    ...Object.keys(categoryBaselines),
    ...Object.keys(categoryContexts),
  ]);

  for (const cat of allCategories) {
    const bScores = categoryBaselines[cat] ?? [];
    const cScores = categoryContexts[cat] ?? [];
    const b = bScores.length > 0 ? bScores.reduce((a, v) => a + v, 0) / bScores.length : 0;
    const c = cScores.length > 0 ? cScores.reduce((a, v) => a + v, 0) / cScores.length : 0;
    byCategory[cat] = { baseline: b, context: c, delta: c - b };
  }

  return {
    provider,
    model,
    timestamp: new Date().toISOString(),
    repos: reports,
    aggregate: {
      baseline_mean: baselineMean,
      context_mean: contextMean,
      accuracy_gain: contextMean - baselineMean,
      by_category: byCategory,
    },
  };
}
