import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { manifestPath } from "../index/paths.js";
import { revParse, isGitRepo } from "../core/git.js";
import { SCHEMA_VERSION } from "../core/schema.js";
import type { BenchProvenance, ConditionName, TaskCategory } from "./types.js";

/** Bumped when category question templates change. */
export const QUESTION_TEMPLATE_VERSION = 1;
/** Bumped when token-estimator.ts character ratios change. */
export const TOKEN_ESTIMATOR_VERSION = 1;
/** Bumped when T3 BM25 zone weights / k1 / b change. */
export const BM25_VERSION = 1;
/** Bumped when T2 impact algorithm changes (maxDepth default, graph shape). */
export const IMPACT_VERSION = 1;
/** Bumped when T4 rule-schema semantics change. */
export const POLICY_VERSION = 1;

export const PACK_BUDGET_DEFAULT = 4000;

export interface BuildProvenanceInput {
  projectRoot: string;
  seed: number;
  iterations: number;
  armSet: readonly ConditionName[];
  categorySet: readonly TaskCategory[];
  provider: string;
  model: string;
  packBudgetDefault?: number;
}

/**
 * Records every input that the bench harness must match for a re-run to be
 * byte-for-byte identical (modulo `timestamp` + `latency_ms`).
 */
export async function buildProvenance(
  input: BuildProvenanceInput,
): Promise<BenchProvenance> {
  const [autocontextVersion, indexVersion, gitSha] = await Promise.all([
    readAutocontextVersion(input.projectRoot),
    readIndexVersion(input.projectRoot),
    readGitSha(input.projectRoot),
  ]);

  return {
    seed: input.seed,
    iterations: input.iterations,
    arm_set: input.armSet,
    category_set: input.categorySet,
    autocontext_version: autocontextVersion,
    autocontext_git_sha: gitSha,
    schema_version: SCHEMA_VERSION,
    index_version: indexVersion,
    bm25_version: BM25_VERSION,
    impact_version: IMPACT_VERSION,
    policy_version: POLICY_VERSION,
    question_template_version: QUESTION_TEMPLATE_VERSION,
    token_estimator_version: TOKEN_ESTIMATOR_VERSION,
    provider: input.provider,
    model: input.model,
    pack_budget_default: input.packBudgetDefault ?? PACK_BUDGET_DEFAULT,
  };
}

async function readAutocontextVersion(projectRoot: string): Promise<string> {
  // Prefer the consumer's own package.json (when autocontext is a dep) —
  // fall back to our checked-in package.json path if running in-tree.
  for (const candidate of [
    join(projectRoot, "node_modules/autocontext/package.json"),
    // In-tree path: reach the package root from either src/ or dist/.
    resolvePackageJson(),
  ]) {
    if (!candidate) continue;
    try {
      const pkg = JSON.parse(await readFile(candidate, "utf-8"));
      if (typeof pkg.version === "string" && (pkg.name === "autocontext" || !pkg.name)) {
        return pkg.version;
      }
    } catch {
      // fall through
    }
  }
  return "unknown";
}

function resolvePackageJson(): string | null {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return url.pathname;
  } catch {
    return null;
  }
}

async function readIndexVersion(projectRoot: string): Promise<number | null> {
  if (!existsSync(manifestPath(projectRoot))) return null;
  try {
    const raw = await readFile(manifestPath(projectRoot), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.index_version === "number" ? parsed.index_version : null;
  } catch {
    return null;
  }
}

async function readGitSha(projectRoot: string): Promise<string | null> {
  try {
    if (!(await isGitRepo(projectRoot))) return null;
    return await revParse(projectRoot, "HEAD");
  } catch {
    return null;
  }
}
