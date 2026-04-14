import { existsSync } from "node:fs";
import { resolve as pathResolve, posix } from "node:path";
import { toFileId } from "./paths.js";
import type { FileId } from "./types.js";

/**
 * Cross-file import resolver. v1 covers TypeScript/JavaScript; Python/Go/Rust
 * adapters slot in as follow-ups. All inputs are POSIX-normalized FileIds
 * and the resolver returns a POSIX FileId or `null` for external/unresolved.
 */
export interface ResolverContext {
  projectRoot: string;
  /** All FileIds known to exist in the project, for O(1) lookups. */
  fileSet: ReadonlySet<FileId>;
}

export function createResolverContext(
  projectRoot: string,
  candidateFiles: Iterable<FileId>,
): ResolverContext {
  return {
    projectRoot,
    fileSet: new Set(candidateFiles),
  };
}

const TS_EXT_TRY = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const INDEX_NAMES = TS_EXT_TRY.map((e) => `index${e}`);

/**
 * Resolve a TS/JS import. Returns the target FileId, or null if external /
 * unresolvable. Deliberately narrow — we never walk node_modules, never honor
 * webpack aliases, never honor TS project references.
 */
export function resolveTsImport(
  fromFile: FileId,
  rawSpecifier: string,
  ctx: ResolverContext,
): FileId | null {
  // Relative imports are the only kind we resolve in v1.
  if (!rawSpecifier.startsWith(".")) return null;

  const fromDir = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(fromDir, rawSpecifier));

  // Candidate 1: path as written (if it already has an extension).
  const hasExt = /\.[a-z0-9]+$/i.test(joined);
  if (hasExt) {
    // If user wrote "./foo.js" but the source is .ts, try the TS variant first.
    const stripped = joined.replace(/\.(m|c)?jsx?$/i, "");
    for (const ext of TS_EXT_TRY) {
      const candidate = `${stripped}${ext}`;
      if (ctx.fileSet.has(candidate)) return candidate;
    }
    if (ctx.fileSet.has(joined)) return joined;
  }

  // Candidate 2: joined + each extension.
  for (const ext of TS_EXT_TRY) {
    const candidate = `${joined}${ext}`;
    if (ctx.fileSet.has(candidate)) return candidate;
  }

  // Candidate 3: joined + /index.<ext>.
  for (const name of INDEX_NAMES) {
    const candidate = `${joined}/${name}`;
    if (ctx.fileSet.has(candidate)) return candidate;
  }

  // Last-resort probe against the actual filesystem, for files that aren't in
  // the candidate set (e.g. not a tracked source extension but still imported).
  if (hasExt) {
    const abs = pathResolve(ctx.projectRoot, joined);
    if (existsSync(abs)) return toFileId(joined);
  }

  return null;
}

/** Dispatch helper — keeps callers language-agnostic. */
export function resolveImport(
  fromFile: FileId,
  rawSpecifier: string,
  ext: string,
  ctx: ResolverContext,
): FileId | null {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    return resolveTsImport(fromFile, rawSpecifier, ctx);
  }
  // Other languages handled in future commits.
  return null;
}

/** Directory helper used by DirEdge rollups. */
export function dirOfFileId(fileId: FileId): string {
  return posix.dirname(fileId);
}
