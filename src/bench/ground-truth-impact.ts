import { posix } from "node:path";
import type { IndexStore } from "../index/store.js";
import { computeImpact } from "../impact/impact.js";
import type { BenchTask } from "./types.js";
import { seededSample } from "./tasks.js";

const MAX_IMPACT_TASKS_DEFAULT = 5;
const IMPACT_MAX_DEPTH = 3;
const SCOPES_MIN = 1;
const SCOPES_MAX = 20;

const TEST_DIR_RE = /(^|\/)(tests?|__tests?__|spec)($|\/)/;

export interface GenerateImpactTasksInput {
  index: IndexStore;
  indexVersion: number;
  /** IMPACT_VERSION from T2 (for provenance). */
  impactVersion?: number;
  maxImpactTasks?: number;
  seed?: number;
}

/**
 * Synthesize ground-truth for `impact-of-change` tasks using T2's
 * computeImpact. Filters test-only directories and keeps the expected
 * scope set bounded.
 */
export async function generateImpactTasks(
  input: GenerateImpactTasksInput,
): Promise<BenchTask[]> {
  const seed = input.seed ?? 42;
  const maxTasks = input.maxImpactTasks ?? MAX_IMPACT_TASKS_DEFAULT;

  // Discover candidate files: we need files that appear as import sources
  // (so T1 actually knows about them).
  const seenFiles = new Set<string>();
  for await (const edge of input.index.scanImports()) {
    seenFiles.add(edge.from);
  }
  const candidates = [...seenFiles].sort();

  const keep: Array<{ file: string; scopes: string[] }> = [];
  for (const file of candidates) {
    const report = await computeImpact(
      input.index,
      [{ file, reason: "file" }],
      { maxDepth: IMPACT_MAX_DEPTH, maxResults: 50 },
    );
    const scopes = report.affected_scopes
      .map((s) => s.scope)
      .filter((s) => !TEST_DIR_RE.test(s))
      .sort();
    if (scopes.length >= SCOPES_MIN && scopes.length <= SCOPES_MAX) {
      keep.push({ file, scopes });
    }
    if (keep.length >= maxTasks * 6) break; // enough candidates
  }

  const chosen = seededSample(keep, maxTasks, seed);
  return chosen.map(({ file, scopes }) => ({
    id: `impact-of-change:${file}`,
    category: "impact-of-change",
    question: `If the file \`${file}\` changes, which directories' documentation/context should be re-reviewed? List project-relative directory paths, one per line. Exclude test-only directories.`,
    scoring: "file_set_f1",
    expected: scopes,
    source_scope: posix.dirname(file) === "." ? "." : posix.dirname(file),
    ground_truth_provenance: {
      source: "t2_impact",
      precision_class: "import_bound",
      recall_class: "imperfect",
      t1_index_version: input.indexVersion,
      t2_algorithm_version: input.impactVersion ?? 1,
      t2_max_depth: IMPACT_MAX_DEPTH,
    },
  }));
}
