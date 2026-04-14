/**
 * autocontext library entry (T3-B + T11 seed).
 * Curated surface: stable items are re-exported plainly; experimental
 * symbols ship with an @experimental JSDoc tag so consumers opt in knowingly.
 */

// --- Stable v0 ---
export { buildPack } from "./pack/pack.js";
export type { Pack, PackOptions, PackScope } from "./pack/types.js";
export { formatPackJson, formatPackMarkdown } from "./pack/format.js";

export { scanProject, flattenBottomUp } from "./core/scanner.js";
export type { ScanResult } from "./core/scanner.js";
export { readContext, writeContext, UnsupportedVersionError } from "./core/writer.js";
export { checkFreshness, legacyState } from "./core/fingerprint.js";
export type { FreshnessState, LegacyFreshnessState } from "./core/fingerprint.js";
export { loadConfig } from "./utils/config.js";
export type { ContextFile, ConfigFile } from "./core/schema.js";
export { contextSchema, configSchema, SCHEMA_VERSION } from "./core/schema.js";

// --- Experimental (T11 will stabilize these once they have consumers) ---

/** @experimental Open the local code index for reading. */
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

/** @experimental Impact analysis over the import-bound reference graph. */
export { computeImpact, IMPACT_CAVEAT } from "./impact/impact.js";
export type { ImpactReport, ImpactSeed } from "./impact/impact.js";

/** @experimental Semantic fingerprint computation (T2). */
export {
  computeSemanticFingerprint,
  SEMANTIC_FINGERPRINT_MARKER,
} from "./core/semantic-fingerprint.js";
