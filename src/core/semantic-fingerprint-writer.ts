import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ScanResult } from "./scanner.js";
import { readContext, writeContext, UnsupportedVersionError } from "./writer.js";
import {
  computeSemanticFingerprint,
  extractPolicyFacts,
} from "./semantic-fingerprint.js";
import { manifestPath } from "../index/paths.js";
import { openIndex } from "../index/store.js";

export interface StampResult {
  /** How many yamls gained a semantic_fingerprint (or had one refreshed). */
  updated: number;
  /** How many were skipped because the file isn't readable / no yaml. */
  skipped: number;
  /** How many new-vs-existing semantic fingerprints actually differ. */
  changed: number;
}

/**
 * After the regular generator loop finishes writing .context.yaml files and
 * the local code index has been rebuilt, walk every tracked directory and
 * stamp its `semantic_fingerprint` into the yaml. Runs as a lightweight
 * post-pass so generators stay pure and the index can be used at write time
 * without restructuring their call signature.
 *
 * A missing / un-openable index is a no-op — callers that care surface this
 * via `hasIndex(root)` before calling.
 */
export async function stampSemanticFingerprintsForDirs(
  projectRoot: string,
  dirs: ScanResult[],
): Promise<StampResult> {
  const root = resolve(projectRoot);
  if (!existsSync(manifestPath(root))) {
    return { updated: 0, skipped: dirs.length, changed: 0 };
  }

  const store = await openIndex(root, { readOnly: true, autoRebuild: false });
  try {
    let updated = 0;
    let skipped = 0;
    let changed = 0;
    for (const dir of dirs) {
      let ctx;
      try {
        ctx = await readContext(dir.path);
      } catch (err) {
        if (err instanceof UnsupportedVersionError) {
          skipped++;
          continue;
        }
        throw err;
      }
      if (!ctx) {
        skipped++;
        continue;
      }
      const facts = extractPolicyFacts(ctx);
      const { sem_fp_12 } = await computeSemanticFingerprint(
        dir.path,
        facts,
        store,
        root,
      );
      if (ctx.semantic_fingerprint === sem_fp_12) {
        // Already up to date — still counted as "updated" for consistency
        // with the fingerprint/sem_fp parity.
        updated++;
        continue;
      }
      if (ctx.semantic_fingerprint && ctx.semantic_fingerprint !== sem_fp_12) {
        changed++;
      }
      ctx.semantic_fingerprint = sem_fp_12;
      await writeContext(dir.path, ctx);
      updated++;
    }
    return { updated, skipped, changed };
  } finally {
    await store.close();
  }
}

/** Returns true iff a code index manifest exists at the project root. */
export function hasIndex(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}
