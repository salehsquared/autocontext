export type TaskCategory =
  | "comprehension"
  | "dependency"
  | "change_impact"
  | "task_routing"
  | "bug_localization"
  | "patch_planning"
  | "find-definition"
  | "find-callers"
  | "impact-of-change"
  | "budget-answer";

export type ScoringMethod =
  | "llm_judge"
  | "list_coverage"
  | "topk_recall"
  | "target_hit"
  | "mrr"
  | "file_set_f1";

/**
 * Canonical arm list. The two legacy arms stay first for back-compat with
 * code that splits on `condition === "baseline"` etc.
 */
export const ARMS = ["baseline", "context", "pack", "pack+impact", "pack+policy"] as const;
export const DEFAULT_ARM_SET = ["baseline", "context"] as const;
export type ConditionName = (typeof ARMS)[number];

export interface BenchTaskSeed {
  kind: "query" | "file" | "symbol";
  value: string;
}

export interface GroundTruthProvenance {
  source:
    | "t1_symbols"
    | "t1_references"
    | "t2_impact"
    | "git_log"
    | "dir_scan"
    | "paired_task";
  precision_class: "authoritative" | "import_bound" | "heuristic";
  recall_class: "exhaustive" | "imperfect" | "not_applicable";
  t1_index_version?: number;
  t2_algorithm_version?: number;
  t2_max_depth?: number;
  paired_task_id?: string;
}

export interface BenchTask {
  id: string;
  category: TaskCategory;
  question: string;
  scoring: ScoringMethod;
  expected: string[];
  source_scope: string;
  /** Preferred deterministic seed for pack/impact arms. */
  task_seed?: BenchTaskSeed;
  /** Provenance of the ground-truth set. Added in T12. */
  ground_truth_provenance?: GroundTruthProvenance;
  /** Only populated on budget-answer tasks. */
  budget_tokens?: number;
}

export interface TaskResultWarning {
  kind: string;
  detail?: string;
}

export interface TaskResult {
  task_id: string;
  condition: ConditionName;
  iteration: number;
  response: string;
  score: number;
  abstained: boolean;
  latency_ms: number;
  answer_input_tokens_est: number;
  judge_input_tokens_est: number;
  total_input_tokens_est: number;
  /** @deprecated legacy alias for total_input_tokens_est */
  scope_tokens_est?: number;
  /** Tokens the provider's response used (estimated). T12 addition. */
  answer_output_tokens_est?: number;
  /** True when a budget-answer task's response exceeded its cap by >10%. */
  budget_exceeded?: boolean;
  /** Pack's cacheKey when arm ∈ {pack, pack+impact, pack+policy}. */
  pack_cache_key?: string;
  /** Structured warnings from arm builders (e.g., t2_unavailable). */
  warnings?: TaskResultWarning[];
}

export interface ConditionSummary {
  condition: ConditionName;
  tasks_run: number;
  mean_score: number;
  stddev_score: number;
  abstention_rate: number;
  mean_latency_ms: number;
  total_answer_tokens_est: number;
  total_judge_tokens_est: number;
  total_tokens_est: number;
  cost_per_correct: number;
  by_category: Record<string, { count: number; mean_score: number }>;
}

/**
 * Reproducibility metadata. Same tuple of `seed`, versions, arm_set, and
 * model must produce byte-identical reports (modulo `timestamp` +
 * `results[].latency_ms`). Added in T12.
 */
export interface BenchProvenance {
  seed: number;
  iterations: number;
  arm_set: readonly ConditionName[];
  category_set: readonly TaskCategory[];
  autocontext_version: string;
  autocontext_git_sha: string | null;
  schema_version: number;
  index_version: number | null;
  bm25_version: number | null;
  impact_version: number | null;
  policy_version: number | null;
  question_template_version: number;
  token_estimator_version: number;
  provider: string;
  model: string;
  pack_budget_default: number;
}

export interface ArmCellStats {
  count: number;
  mean_score: number;
  stddev_score: number;
  mean_latency_ms: number;
  mean_tokens: number;
}

export interface ArmDelta {
  accuracy_gain: number;
  abstention_reduction: number;
  token_reduction: number;
  cost_per_correct_reduction: number;
}

export interface BenchReport {
  root: string;
  repo?: string;
  provider: string;
  model: string;
  iterations: number;
  seed: number;
  timestamp: string;
  task_count: number;
  baseline: ConditionSummary;
  context: ConditionSummary;
  delta: ArmDelta;
  tasks: BenchTask[];
  results: TaskResult[];

  /** Full arm-indexed map. `baseline`/`context` are duplicated here for
   *  consistency. Added in T12. Partial because not every arm runs on
   *  every invocation. */
  arms?: Partial<Record<ConditionName, ConditionSummary>>;
  /** Per-arm × per-category cell stats. */
  matrix?: Partial<Record<ConditionName, Record<string, ArmCellStats>>>;
  /** Deltas of every non-context arm vs the `context` arm (the historical baseline). */
  arm_deltas?: Partial<Record<Exclude<ConditionName, "context">, ArmDelta>>;
  /** Reproducibility pinning block. */
  provenance?: BenchProvenance;
}

export interface MultiRepoReport {
  provider: string;
  model: string;
  timestamp: string;
  repos: BenchReport[];
  aggregate: {
    baseline_mean: number;
    context_mean: number;
    accuracy_gain: number;
    by_category: Record<string, { baseline: number; context: number; delta: number }>;
    /** T12 additions: per-arm + matrix aggregates. */
    by_arm?: Partial<Record<ConditionName, { mean_score: number; abstention_rate: number; mean_tokens: number }>>;
    matrix?: Partial<Record<ConditionName, Record<string, { count: number; mean_score: number }>>>;
  };
}

export interface Commit {
  sha: string;
  message: string;
  files: string[];
}

export interface DirFacts {
  files: string[];
  exports: string[];
  fileCount: number;
}

export interface BenchOptions {
  path?: string;
  json?: boolean;
  iterations?: number;
  tasks?: string;
  maxTasks?: number;
  seed?: number;
  category?: TaskCategory;
  out?: string;
  allowStale?: boolean;
  repo?: string;
  defaultRepos?: boolean;
  /** Subset of arms to run. Default: ["baseline", "context"] for back-compat. */
  arm?: string;
  /** Token budget for pack arms. Default 4000. */
  packBudget?: number;
}
