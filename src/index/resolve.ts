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
  if (ext === ".py") {
    return resolvePyImport(fromFile, rawSpecifier, ctx);
  }
  // Other languages handled in future commits.
  return null;
}

/**
 * Resolve a Python import. Handles both `from X import Y` and `import X`.
 * Absolute imports walk up from the file's directory looking for the module
 * as either `<name>.py` or `<name>/__init__.py`. Relative imports (`.x`,
 * `..pkg.x`) apply the dot count then join with the rest.
 */
export function resolvePyImport(
  fromFile: FileId,
  rawSpecifier: string,
  ctx: ResolverContext,
): FileId | null {
  const dotMatch = rawSpecifier.match(/^(\.+)(.*)$/);
  const fromDir = posix.dirname(fromFile);

  if (dotMatch) {
    const dots = dotMatch[1].length;
    const rest = dotMatch[2];
    let base = fromDir;
    for (let i = 1; i < dots; i++) {
      base = posix.dirname(base);
      if (base === ".") base = "";
    }
    const joined = rest
      ? posix.join(base || ".", rest.replace(/\./g, "/"))
      : base || ".";
    return pyCandidate(joined, ctx);
  }

  const modulePath = rawSpecifier.replace(/\./g, "/");
  let cur = fromDir;
  // Cap the ancestor walk so we can't loop forever on odd FileId shapes.
  for (let depth = 0; depth < 32; depth++) {
    const joined = cur === "." || cur === "" ? modulePath : posix.join(cur, modulePath);
    const found = pyCandidate(joined, ctx);
    if (found) return found;
    const parent = posix.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function pyCandidate(joined: string, ctx: ResolverContext): FileId | null {
  const normalized = joined.replace(/^\.?\//, "").replace(/^\.$/, "");
  const withExt = normalized === "" ? "" : `${normalized}.py`;
  if (withExt && ctx.fileSet.has(withExt)) return withExt;
  const pkg = normalized === "" ? "__init__.py" : `${normalized}/__init__.py`;
  if (ctx.fileSet.has(pkg)) return pkg;
  return null;
}

/** Directory helper used by DirEdge rollups. */
export function dirOfFileId(fileId: FileId): string {
  return posix.dirname(fileId);
}
