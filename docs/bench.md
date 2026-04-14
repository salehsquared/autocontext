# Benchmark Command

`context bench` compares baseline prompts (scoped tree + README excerpt) against context prompts (scoped `.context.yaml`) and reports accuracy, abstention, token, and latency deltas.

## Usage

```bash
context bench [options]
```

## Options

| Option | Description |
|---|---|
| `--json` | Output machine-readable JSON |
| `--iterations <n>` | Repeat each task `n` times |
| `--tasks <path>` | Reserved for future manual task-file support (currently no effect) |
| `--max-tasks <n>` | Maximum number of generated tasks |
| `--seed <n>` | Seed for deterministic sampling |
| `--category <cat>` | Run only one task category |
| `--out <file>` | Write JSON report to file |
| `--allow-stale` | Include stale context files instead of failing |
| `--repo <url>` | Clone and benchmark a remote repository |
| `--default-repos` | Run a multi-repo benchmark over curated defaults |
| `-p, --path <path>` | Project root for config and local benchmark mode |

## Modes

### Local Repository

```bash
context bench --max-tasks 24 --iterations 3 --seed 42
```

Uses your current project as the benchmark target.

### Remote Repository

```bash
context bench --repo https://github.com/colinhacks/zod --max-tasks 24 --seed 42
```

Clones the repo into a temp directory, runs static `context init`, then benchmarks.

### Multi-Repo Mode

```bash
context bench --default-repos --iterations 2 --out /tmp/bench.json
```

Runs the benchmark over curated repos and aggregates results.

## Prerequisites

- Provider must be configured in your invoking project:

```bash
context config --provider openai --model gpt-4o-mini
```

- Required provider API key env var must be set.
- Context files must be fresh unless `--allow-stale` is passed.

## Output Summary

Human-readable mode reports:

- Overall baseline vs context score with deltas
- Abstention rate change
- Estimated input token change
- Average latency
- Per-category performance

JSON mode includes full run metadata and per-task/per-iteration results for analysis pipelines.

## Comparator arms (T12)

Beyond the historical `baseline` and `context` arms, the bench harness can now run three additional arms that exercise the upstream capability tracks:

| Arm | Prompt content | What it tests |
|---|---|---|
| `baseline` | README excerpt + scoped file tree | Do `.context.yaml` files beat a minimal context at all? |
| `context` | Scoped `.context.yaml` for the task's directory | Do authored summaries beat README? |
| `pack` | `buildPack({seed, budget})` output rendered as markdown | Does the pack ranker pick more useful scopes than a flat context dump? |
| `pack+impact` | Pack + T2's `computeImpact` scopes for the task's target | Does explicit blast-radius improve impact-style questions? |
| `pack+policy` | Pack + T4 `Violation` list whose scope overlaps the admitted pack scopes | Do policy violations improve routing/constraint questions? |

## Task categories (T12 additions)

Three new categories, each grounded in the T1 index or T2 impact algorithm — never hand-labelled:

| Category | Question | Ground truth |
|---|---|---|
| `find-definition` | "Which file defines symbol `X`?" | `Symbol.file` for the unique exported symbol named `X`. |
| `find-callers` | "Which files import symbol `X`?" | `getReferencesTo(symbol.id).file` — **import-bound only**. |
| `impact-of-change` | "If file `F` changes, which directories are affected?" | `computeImpact({seed: {kind:"file", path: F}, maxDepth: 3})` with test-dir filtering. |

Every task carries `ground_truth_provenance: { source, precision_class, recall_class, ... }` so downstream analyzers can filter or weight by confidence tier. Precision is never claimed beyond what T1 can verify.

## Reproducibility (`BenchReport.provenance`)

Each report carries a `provenance` block that pins every input the harness needs to reproduce:

```jsonc
{
  "seed": 42,
  "iterations": 1,
  "arm_set": ["baseline", "context", "pack"],
  "category_set": ["comprehension", "find-definition"],
  "autocontext_version": "0.2.0",
  "autocontext_git_sha": "deadbeef…",
  "schema_version": 1,
  "index_version": 1,
  "bm25_version": 1,
  "impact_version": 1,
  "policy_version": 1,
  "question_template_version": 1,
  "token_estimator_version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "pack_budget_default": 4000
}
```

Two runs with the same tuple (modulo `timestamp` + `latency_ms`) must produce byte-identical JSON. Same-seed reruns are deterministic at the **task** level; response non-determinism is a provider concern and out of scope.

## Report shape — new fields

`BenchReport` gains three optional top-level fields (additive; legacy consumers keep working):

```jsonc
{
  "baseline": {...},            // unchanged
  "context":  {...},            // unchanged
  "delta":    {...},            // unchanged
  "arms": {                     // per-arm summaries keyed by arm name
    "baseline": {...}, "context": {...}, "pack": {...}
  },
  "matrix": {                   // arm × category cells
    "pack": {
      "find-definition": { "count": 5, "mean_score": 0.92, "stddev_score": 0.08, ... }
    }
  },
  "arm_deltas": {               // each non-context arm's gap vs context
    "pack": { "accuracy_gain": 0.12, "abstention_reduction": 0.04, ... }
  },
  "provenance": {...}
}
```

## Regression canary

`scripts/compare-bench.mjs` diffs two JSON reports and exits non-zero when any key metric regressed beyond a threshold:

```bash
node scripts/compare-bench.mjs bench/baselines/autocontext-self.json new.json --threshold 0.02
# exit 0 — no regression
# exit 1 — at least one metric dropped by more than 0.02
# exit 2 — schema_version or question_template_version mismatch (incomparable)
```

The script checks `delta.accuracy_gain` and every `arm_deltas[arm].accuracy_gain` present in the baseline. It refuses to compare reports with divergent `question_template_version` or `schema_version` — that correctly forces a baseline refresh.

To capture a fresh baseline (one-shot, when you have a provider API key configured):

```bash
context bench --json --allow-stale > bench/baselines/autocontext-self.json
```

## Library usage

```ts
import { runBench, generateTasks, generateSymbolTasks } from "autocontext";

const tasks = await generateTasks({...});                          // existing categories
const { findDefinitionTasks, findCallersTasks } = await generateSymbolTasks({
  index, indexVersion: 1, maxDefinitionTasks: 5,
});

const result = await runBench({
  tasks: [...tasks, ...findDefinitionTasks],
  provider, providerName: "anthropic", modelName: "claude",
  scanResult, readme, contextFiles, iterations: 1,
});
```

See [docs/library.md](library.md) for the full stable/experimental split.
