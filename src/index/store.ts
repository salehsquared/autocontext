import type {
  DirEdge,
  FileFingerprint,
  FileId,
  ImportEdge,
  IndexManifest,
  IndexSymbol,
  Reference,
} from "./types.js";

/**
 * The only seam between T1-B (writers), T2/T3/T4/T6 (readers), and the
 * on-disk layout. Implementations MUST be interchangeable: a future SQLite
 * backend should Just Work behind this interface.
 */
export interface IndexStore {
  readonly manifest: IndexManifest;
  close(): Promise<void>;

  // ---- writers ----

  /**
   * Replace the index entries for a single file atomically. Deletes all
   * existing symbols/imports/references/fingerprint keyed on `file`, then
   * writes the new ones. Safe to call concurrently on DIFFERENT files.
   */
  writeFile(input: {
    file: FileId;
    symbols: IndexSymbol[];
    imports: ImportEdge[];
    references: Reference[];
    fingerprint: FileFingerprint;
  }): Promise<void>;

  /** Drop every record keyed on `file`. */
  dropFile(file: FileId): Promise<void>;

  /** Recompute and overwrite dir_edges.json from current ImportEdges. */
  recomputeDirEdges(): Promise<void>;

  /** Rewrite the manifest header. */
  writeManifest(update: Partial<IndexManifest>): Promise<void>;

  // ---- incremental planning ----

  diffAgainstDisk(
    projectRoot: string,
    candidateFiles: FileId[],
  ): Promise<{
    changed: FileId[];
    added: FileId[];
    removed: FileId[];
    unchanged: FileId[];
  }>;

  // ---- readers ----

  getFileSymbols(file: FileId): Promise<IndexSymbol[]>;
  getFileImports(file: FileId): Promise<ImportEdge[]>;
  getFileFingerprint(file: FileId): Promise<FileFingerprint | null>;

  findSymbolsByName(
    name: string,
    scope?: { file?: FileId; dir?: string },
  ): Promise<IndexSymbol[]>;
  getSymbol(id: string): Promise<IndexSymbol | null>;

  getReferencesTo(symbolId: string): Promise<Reference[]>;
  getReferencesFrom(file: FileId): Promise<Reference[]>;

  scanImports(filter?: {
    fromGlob?: string;
    toGlob?: string;
  }): AsyncIterable<ImportEdge>;

  getDirEdges(): Promise<DirEdge[]>;

  getImporters(file: FileId): Promise<FileId[]>;
  getImportees(file: FileId): Promise<FileId[]>;
}

export interface OpenIndexOptions {
  autoRebuild?: boolean;
  readOnly?: boolean;
  /** Injected for tests; defaults to package.json version lookup in real use. */
  autocontextVersion?: string;
  /** Injected for tests; keys = wasm filename, value = hash. */
  grammarHashes?: Record<string, string>;
}

/** Factory. Resolves to an open store with a lock held for its lifetime. */
export async function openIndex(
  projectRoot: string,
  options?: OpenIndexOptions,
): Promise<IndexStore> {
  const { openNdjsonIndex } = await import("./ndjson-store.js");
  return openNdjsonIndex(projectRoot, options);
}
