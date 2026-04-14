/**
 * autocontext library entry — the curated public surface.
 *
 * Consumers reach these symbols via `import … from "autocontext"`. Everything
 * here is tagged `@stability stable` or `@stability experimental`. Stable
 * symbols follow semver from 1.0.0 onward; experimental ones may change in
 * minor versions until they graduate.
 *
 * Do NOT add wildcard re-exports. Do NOT re-export from ./index.ts (the CLI).
 * Anything beyond this barrel is an implementation detail.
 */

// =============================================================================
// Pack — T3 (stable v0)
// =============================================================================

/** @stability stable */
export { buildPack } from "./pack/pack.js";
/** @stability stable */
export { formatPackJson, formatPackMarkdown } from "./pack/format.js";

export type { Pack, PackOptions, PackScope } from "./pack/types.js";

// =============================================================================
// Core — existing (stable v0)
// =============================================================================

/** @stability stable */
export { scanProject, flattenBottomUp } from "./core/scanner.js";
export type { ScanResult } from "./core/scanner.js";

/** @stability stable */
export { readContext, writeContext, UnsupportedVersionError } from "./core/writer.js";

/** @stability stable */
export { checkFreshness, legacyState } from "./core/fingerprint.js";
export type { FreshnessState, LegacyFreshnessState } from "./core/fingerprint.js";

/** @stability stable */
export { loadConfig } from "./utils/config.js";

export type { ContextFile, ConfigFile } from "./core/schema.js";
export { contextSchema, configSchema, SCHEMA_VERSION, CONTEXT_FILENAME, CONFIG_FILENAME } from "./core/schema.js";

// =============================================================================
// Index / graph — T1 (experimental)
// =============================================================================

/** @stability experimental */
export { openIndex } from "./index/store.js";
export type { IndexStore } from "./index/store.js";
export type {
  FileId,
  ImportEdge,
  IndexSymbol,
  Reference,
  DirEdge,
  FileFingerprint,
  IndexManifest,
} from "./index/types.js";

// =============================================================================
// Impact — T2 (experimental)
// =============================================================================

/** @stability experimental */
export { computeImpact, IMPACT_CAVEAT } from "./impact/impact.js";
export type { ImpactReport, ImpactSeed } from "./impact/impact.js";

// =============================================================================
// Semantic staleness — T2 (experimental)
// =============================================================================

/** @stability experimental */
export {
  computeSemanticFingerprint,
  extractPolicyFacts,
  SEMANTIC_FINGERPRINT_MARKER,
} from "./core/semantic-fingerprint.js";

// =============================================================================
// Policy — T4 (experimental)
// =============================================================================

/** @stability experimental */
export { runPolicies } from "./policy/engine.js";
export type {
  PolicyRunResult,
  RunPoliciesOptions,
  IndexState as PolicyIndexState,
} from "./policy/engine.js";
export type {
  Rule,
  RuleKind,
  ForbidImportRule,
  RequireImportRule,
  RequireExportRule,
  MaxFileLinesRule,
  RequireTestFileRule,
  DependencyBoundaryRule,
  EvidenceRequiresRule,
} from "./policy/rules.js";
export type { Violation as PolicyViolation } from "./policy/types.js";
export { ruleSchema, RULE_KINDS } from "./policy/rules.js";

// =============================================================================
// Bench — T12 (experimental)
// =============================================================================

/** @stability experimental */
export { runBench } from "./bench/runner.js";
/** @stability experimental */
export { generateTasks } from "./bench/tasks.js";
/** @stability experimental */
export { generateSymbolTasks } from "./bench/ground-truth-symbols.js";
/** @stability experimental */
export { generateImpactTasks } from "./bench/ground-truth-impact.js";
/** @stability experimental */
export { buildProvenance } from "./bench/provenance.js";
export type {
  BenchTask,
  BenchReport,
  ConditionName,
  TaskCategory,
  ScoringMethod,
  TaskResult,
  ConditionSummary,
  BenchProvenance,
  ArmCellStats,
  ArmDelta,
  GroundTruthProvenance,
} from "./bench/types.js";
export { ARMS } from "./bench/types.js";
