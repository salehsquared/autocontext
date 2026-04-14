import { describe, it, expect } from "vitest";
import { aggregateResults } from "../../src/bench/scorer.js";
import type { BenchTask, TaskResult } from "../../src/bench/types.js";

function mkTask(id: string, category: BenchTask["category"]): BenchTask {
  return {
    id,
    category,
    question: "Q",
    scoring: "target_hit",
    expected: ["x"],
    source_scope: ".",
  };
}

function mkResult(
  overrides: Partial<TaskResult> & Pick<TaskResult, "task_id" | "condition" | "score">,
): TaskResult {
  return {
    iteration: 0,
    response: "yes",
    abstained: false,
    latency_ms: 100,
    answer_input_tokens_est: 500,
    judge_input_tokens_est: 100,
    total_input_tokens_est: 600,
    ...overrides,
  };
}

describe("aggregateResults — T12 matrix + arm_deltas", () => {
  it("produces per-arm × per-category matrix cells", () => {
    const tasks: BenchTask[] = [
      mkTask("t1", "comprehension"),
      mkTask("t2", "find-definition"),
    ];
    const results: TaskResult[] = [
      mkResult({ task_id: "t1", condition: "baseline", score: 0.3, total_input_tokens_est: 1000 }),
      mkResult({ task_id: "t1", condition: "context", score: 0.6, total_input_tokens_est: 700 }),
      mkResult({ task_id: "t1", condition: "pack", score: 0.8, total_input_tokens_est: 400 }),
      mkResult({ task_id: "t2", condition: "baseline", score: 0.1, total_input_tokens_est: 1000 }),
      mkResult({ task_id: "t2", condition: "context", score: 0.4, total_input_tokens_est: 700 }),
      mkResult({ task_id: "t2", condition: "pack", score: 0.9, total_input_tokens_est: 400 }),
    ];
    const report = aggregateResults("/t", "anthropic", "claude", 1, 42, tasks, results);

    expect(report.matrix).toBeDefined();
    expect(report.matrix!.pack?.["comprehension"]?.mean_score).toBeCloseTo(0.8);
    expect(report.matrix!.pack?.["find-definition"]?.mean_score).toBeCloseTo(0.9);
    expect(report.matrix!.context?.["comprehension"]?.mean_score).toBeCloseTo(0.6);
  });

  it("computes arm_deltas[pack].accuracy_gain vs context", () => {
    const tasks: BenchTask[] = [mkTask("t1", "comprehension")];
    const results: TaskResult[] = [
      mkResult({ task_id: "t1", condition: "context", score: 0.5 }),
      mkResult({ task_id: "t1", condition: "pack", score: 0.8 }),
    ];
    const report = aggregateResults("/t", "x", "y", 1, 42, tasks, results);
    expect(report.arm_deltas?.pack?.accuracy_gain).toBeCloseTo(0.3);
  });

  it("populates arms[] for every arm present in results", () => {
    const tasks: BenchTask[] = [mkTask("t1", "comprehension")];
    const results: TaskResult[] = [
      mkResult({ task_id: "t1", condition: "baseline", score: 0 }),
      mkResult({ task_id: "t1", condition: "context", score: 1 }),
      mkResult({ task_id: "t1", condition: "pack+impact", score: 1 }),
    ];
    const report = aggregateResults("/t", "x", "y", 1, 42, tasks, results);
    expect(Object.keys(report.arms ?? {}).sort()).toEqual([
      "baseline",
      "context",
      "pack+impact",
    ]);
  });

  it("preserves legacy baseline/context/delta fields unchanged", () => {
    const tasks: BenchTask[] = [mkTask("t1", "comprehension")];
    const results: TaskResult[] = [
      mkResult({ task_id: "t1", condition: "baseline", score: 0.3 }),
      mkResult({ task_id: "t1", condition: "context", score: 0.7 }),
    ];
    const report = aggregateResults("/t", "x", "y", 1, 42, tasks, results);
    expect(report.baseline.mean_score).toBeCloseTo(0.3);
    expect(report.context.mean_score).toBeCloseTo(0.7);
    expect(report.delta.accuracy_gain).toBeCloseTo(0.4);
  });
});
