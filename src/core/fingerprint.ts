import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONTEXT_FILENAME } from "./schema.js";

/**
 * Compute a fingerprint for a directory based on file names, mtimes, and sizes.
 * Only considers files directly in the directory (non-recursive).
 * Excludes .context.yaml itself and common non-source directories.
 */
export async function computeFingerprint(dirPath: string, ignorePatterns: string[] = []): Promise<string> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  const fileEntries: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === CONTEXT_FILENAME) continue;
    if (shouldIgnore(entry.name, ignorePatterns)) continue;

    const filePath = join(dirPath, entry.name);
    const fileStat = await stat(filePath);

    fileEntries.push(`${entry.name}:${Math.floor(fileStat.mtimeMs)}:${fileStat.size}`);
  }

  fileEntries.sort();

  const content = fileEntries.join("\n");
  const hash = createHash("sha256").update(content).digest("hex");

  return hash.substring(0, 8);
}

/**
 * Four-state freshness model (T2). The legacy three-state contract is
 * preserved for all existing JSON consumers via `legacyState()`.
 *
 *   fresh          — directory fingerprint matches (and, if the yaml carries
 *                    a semantic_fingerprint, that matches too).
 *   cosmetic_stale — directory fingerprint differs but semantic fingerprint
 *                    is unchanged (or can't be proven changed): formatter
 *                    run, comment edit, non-exported body edit.
 *   semantic_stale — both fingerprints differ: exports/signatures/deps or
 *                    policy facts changed.
 *   missing        — no .context.yaml at this scope.
 */
export type FreshnessState = "fresh" | "cosmetic_stale" | "semantic_stale" | "missing";

/** Legacy three-state projection. Used by every JSON consumer that was alive
 *  before T2 to keep byte-level output contracts. New consumers opt into the
 *  four-state enum via --explain / detailed:true. */
export type LegacyFreshnessState = "fresh" | "stale" | "missing";

export function legacyState(state: FreshnessState): LegacyFreshnessState {
  if (state === "fresh" || state === "missing") return state;
  return "stale";
}

export interface CheckFreshnessOptions {
  /** Stored semantic fingerprint from .context.yaml, if present. */
  storedSemanticFingerprint?: string;
  /** Optional index — if omitted, callers get `cosmetic_stale` at worst. */
  index?: import("../index/store.js").IndexStore;
  /** Parsed policy facts (constraints/rules/environment) from .context.yaml. */
  contextFacts?: import("./semantic-fingerprint.js").PolicyFacts;
  /** Project root, needed to turn dirPath + filename into a FileId. */
  projectRoot?: string;
}

export interface CheckFreshnessResult {
  state: FreshnessState;
  computed: string;
  /** Present iff a semantic fingerprint could be computed (index supplied). */
  computedSemantic?: string;
}

export async function checkFreshness(
  dirPath: string,
  storedFingerprint: string | undefined,
  ignorePatterns: string[] = [],
  opts?: CheckFreshnessOptions,
): Promise<CheckFreshnessResult> {
  const computed = await computeFingerprint(dirPath, ignorePatterns);

  if (storedFingerprint === undefined) {
    return { state: "missing", computed };
  }

  if (storedFingerprint === computed) {
    return { state: "fresh", computed };
  }

  // Disk-fingerprint differs. Decide cosmetic vs semantic.
  if (!opts?.storedSemanticFingerprint) {
    // Legacy yaml (no stored semantic fp). Never report semantic_stale —
    // upgrading the CLI alone shouldn't trigger a mass "semantic" flood.
    return { state: "cosmetic_stale", computed };
  }
  if (!opts.index || !opts.projectRoot) {
    return { state: "cosmetic_stale", computed };
  }

  const { computeSemanticFingerprint } = await import("./semantic-fingerprint.js");
  const { sem_fp_12 } = await computeSemanticFingerprint(
    dirPath,
    opts.contextFacts ?? {},
    opts.index,
    opts.projectRoot,
  );
  if (sem_fp_12 === opts.storedSemanticFingerprint) {
    return { state: "cosmetic_stale", computed, computedSemantic: sem_fp_12 };
  }
  return { state: "semantic_stale", computed, computedSemantic: sem_fp_12 };
}

function shouldIgnore(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (filename === pattern) return true;
    // Simple glob: *.ext
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (filename.endsWith(ext)) return true;
    }
  }
  return false;
}
