import { readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { analyzeFile, type AnalysisOutput } from "./analyzer.js";
import { computeFileFingerprint } from "./fingerprint.js";
import { createResolverContext, resolveImport } from "./resolve.js";
import { toFileId } from "./paths.js";
import type { IndexStore } from "./store.js";
import type {
  FileId,
  ImportEdge,
  IndexSymbol,
  Reference,
} from "./types.js";

export interface BuildFileRecord {
  file: FileId;
  symbols: IndexSymbol[];
  imports: ImportEdge[];
  references: Reference[];
  fingerprint: Awaited<ReturnType<typeof computeFileFingerprint>>;
}

export interface BuildResult {
  files: BuildFileRecord[];
  /** Files the analyzer reached but couldn't parse; no rows written for them. */
  parseErrors: FileId[];
  /** Files skipped because no analyzer supports the extension. */
  fallbackFiles: FileId[];
}

/**
 * Two-pass builder:
 *
 *   1. Parse every candidate file once; collect symbols + imports + "tentative"
 *      references whose `symbol_id` is still pending.
 *   2. Resolve every ImportEdge.raw to a FileId via the resolver, then
 *      back-fill each tentative reference's `symbol_id` by looking up the
 *      target file's Symbol table. References whose target can't be resolved
 *      are dropped.
 *
 * The result is a list of per-file write payloads ready to hand to
 * IndexStore.writeFile. We intentionally do not call the store here — callers
 * own transactional semantics (e.g. the CLI writes, pauses to `recomputeDirEdges`,
 * etc.).
 */
export async function buildIndex(
  projectRoot: string,
  candidateFiles: FileId[],
): Promise<BuildResult> {
  const ctx = createResolverContext(projectRoot, candidateFiles);

  // Pass 1 — per-file parse.
  interface Staged {
    file: FileId;
    abs: string;
    analysis: AnalysisOutput;
  }
  const staged: Staged[] = [];
  const parseErrors: FileId[] = [];
  const fallbackFiles: FileId[] = [];
  const symbolsByFile = new Map<FileId, IndexSymbol[]>();

  for (const file of candidateFiles) {
    const abs = join(projectRoot, file);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const analysis = await analyzeFile(content, file);
    if (analysis.analysisMode === "parse_error") {
      parseErrors.push(file);
      continue;
    }
    if (analysis.analysisMode === "fallback") {
      fallbackFiles.push(file);
      // Still record an empty row so fingerprints persist.
    }
    staged.push({ file, abs, analysis });
    symbolsByFile.set(file, analysis.symbols);
  }

  // Resolve imports.
  for (const s of staged) {
    const ext = extname(s.file).toLowerCase();
    for (const edge of s.analysis.imports) {
      edge.resolved_to = resolveImport(s.file, edge.raw, ext, ctx);
    }
  }

  // Pass 2 — back-fill tentative references.
  const files: BuildFileRecord[] = [];
  for (const s of staged) {
    const edges = s.analysis.imports;
    const refs: Reference[] = [];
    for (const tr of s.analysis.tentativeReferences) {
      const edge = edges.find((e) => e.raw === tr.importRaw);
      if (!edge || !edge.resolved_to) continue;
      const targetSymbols = symbolsByFile.get(edge.resolved_to);
      if (!targetSymbols) continue;
      const target = targetSymbols.find((x) => x.name === tr.remoteName);
      if (!target) continue;

      refs.push({
        symbol_id: target.id,
        file: s.file,
        span: tr.span,
        via_import: { from: s.file, raw: edge.raw },
        kind: "identifier_use",
      });
    }

    const fingerprint = await computeFileFingerprint(s.abs, s.file);
    files.push({
      file: s.file,
      symbols: s.analysis.symbols,
      imports: s.analysis.imports,
      references: refs,
      fingerprint,
    });
  }

  return { files, parseErrors, fallbackFiles };
}

/**
 * Commit a BuildResult to the store in a stable order. Dir-edge rollup runs
 * once at the end. The caller supplies an already-opened store so it can
 * control the lock scope.
 */
export async function commitBuild(
  store: IndexStore,
  result: BuildResult,
  priorIndexedFiles: FileId[] = [],
): Promise<void> {
  const incoming = new Set(result.files.map((r) => r.file));
  for (const prior of priorIndexedFiles) {
    if (!incoming.has(prior)) {
      await store.dropFile(prior);
    }
  }
  for (const record of result.files) {
    await store.writeFile({
      file: record.file,
      symbols: record.symbols,
      imports: record.imports,
      references: record.references,
      fingerprint: record.fingerprint,
    });
  }
  await store.recomputeDirEdges();
}

/** Convenience: translate an absolute path to a POSIX FileId under a project root. */
export function fileIdOf(projectRoot: string, abs: string): FileId {
  return toFileId(relative(projectRoot, abs));
}
