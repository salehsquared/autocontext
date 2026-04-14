#!/usr/bin/env node
/**
 * compare-bench.mjs — regression canary for `context bench --json` reports.
 *
 * Usage:
 *   node scripts/compare-bench.mjs <baseline.json> <candidate.json> [--threshold 0.02]
 *
 * Exits:
 *   0 — no regression
 *   1 — at least one regression exceeding the threshold
 *   2 — reports are not comparable (different schema/template versions)
 *
 * What it checks:
 *   - `delta.accuracy_gain` (context vs baseline) did not drop by more than
 *     the threshold.
 *   - Every `arm_deltas[arm].accuracy_gain` present in the baseline is still
 *     present in the candidate and did not drop by more than the threshold.
 *   - `provenance.question_template_version` matches (different templates →
 *     incomparable; exit 2).
 */

import { readFileSync } from "node:fs";
import { argv, exit, stdout, stderr } from "node:process";

function main() {
  const args = argv.slice(2);
  if (args.length < 2) {
    stderr.write("usage: compare-bench.mjs <baseline.json> <candidate.json> [--threshold <n>]\n");
    exit(2);
  }
  const baselinePath = args[0];
  const candidatePath = args[1];
  let threshold = 0.02;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--threshold") threshold = parseFloat(args[++i]);
  }

  const baseline = readReport(baselinePath);
  const candidate = readReport(candidatePath);

  const baseVersion = baseline.provenance?.question_template_version;
  const candVersion = candidate.provenance?.question_template_version;
  if (baseVersion !== undefined && candVersion !== undefined && baseVersion !== candVersion) {
    stderr.write(
      `[compare-bench] question_template_version mismatch (baseline=${baseVersion}, candidate=${candVersion}). ` +
        "Reports are not comparable.\n",
    );
    exit(2);
  }

  const baseSchema = baseline.provenance?.schema_version;
  const candSchema = candidate.provenance?.schema_version;
  if (baseSchema !== undefined && candSchema !== undefined && baseSchema !== candSchema) {
    stderr.write(
      `[compare-bench] schema_version mismatch (baseline=${baseSchema}, candidate=${candSchema}). ` +
        "Reports are not comparable.\n",
    );
    exit(2);
  }

  const regressions = [];

  // delta.accuracy_gain (legacy context-vs-baseline gap)
  const deltaGap = (candidate.delta?.accuracy_gain ?? 0) - (baseline.delta?.accuracy_gain ?? 0);
  if (deltaGap < -threshold) {
    regressions.push({
      metric: "delta.accuracy_gain",
      baseline: baseline.delta?.accuracy_gain,
      candidate: candidate.delta?.accuracy_gain,
      drop: -deltaGap,
    });
  }

  // arm_deltas[*].accuracy_gain
  const baseArms = baseline.arm_deltas ?? {};
  const candArms = candidate.arm_deltas ?? {};
  for (const arm of Object.keys(baseArms)) {
    const baseGain = baseArms[arm]?.accuracy_gain ?? 0;
    const candGain = candArms[arm]?.accuracy_gain;
    if (candGain === undefined) {
      regressions.push({
        metric: `arm_deltas.${arm}.accuracy_gain`,
        baseline: baseGain,
        candidate: null,
        drop: "arm missing in candidate",
      });
      continue;
    }
    if (candGain - baseGain < -threshold) {
      regressions.push({
        metric: `arm_deltas.${arm}.accuracy_gain`,
        baseline: baseGain,
        candidate: candGain,
        drop: baseGain - candGain,
      });
    }
  }

  const payload = {
    threshold,
    regressions,
    baseline: {
      timestamp: baseline.timestamp,
      git_sha: baseline.provenance?.autocontext_git_sha,
      version: baseline.provenance?.autocontext_version,
    },
    candidate: {
      timestamp: candidate.timestamp,
      git_sha: candidate.provenance?.autocontext_git_sha,
      version: candidate.provenance?.autocontext_version,
    },
  };
  stdout.write(JSON.stringify(payload, null, 2) + "\n");

  exit(regressions.length > 0 ? 1 : 0);
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    stderr.write(`[compare-bench] failed to read ${path}: ${err.message}\n`);
    exit(2);
  }
}

main();
