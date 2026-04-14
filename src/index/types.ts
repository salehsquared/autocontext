// Data model for the autocontext local code index (T1-A).
//
// All types are pure data. They serialize as JSON/NDJSON. Keep them free of
// methods, default values, and non-serializable fields.
//
// Precision boundary (v1) — restated here because these types are read by
// every downstream track:
//   - Symbol:     definitions emitted by the AST queries (exports + internals).
//   - ImportEdge: one per (from_file, raw_module_specifier).
//   - Reference:  ONLY import-bound identifier uses that resolve to a concrete
//                 Symbol.id in another file. No free identifier uses, no
//                 member-access resolution, no call-graph resolution.
//   - DirEdge:    derived directory→directory rollup from ImportEdge rows.
//
// See src/index/README.md for the long-form explanation.

/** Absolute-path-free identifier, stable across checkouts of the same repo. */
export type FileId = string;

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "constant"
  | "enum"
  | "method"
  | "variable";

export interface Span {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** 0-based byte offset of the symbol NAME within the file. */
  nameByteOffset: number;
}

export interface IndexSymbol {
  /** Deterministic id: `${fileId}#${name}@${nameByteOffset}`. */
  id: string;
  file: FileId;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  span: Span;
  signature?: string;
  /** Lowercase extension without dot: "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs". */
  lang: string;
}

export type ImportKind =
  | "static"
  | "cjs_require"
  | "dynamic"
  | "reexport"
  | "py_from"
  | "rust_use";

export interface ImportEdge {
  from: FileId;
  /** Raw module specifier as written. */
  raw: string;
  /** Best-effort resolution. Null when external/unresolved. */
  resolved_to?: FileId | null;
  /** Named symbols imported, normalized. */
  symbols: string[];
  kind: ImportKind;
  /** 1-based line of the import statement. */
  line: number;
}

export interface Reference {
  /** The definition being referenced. Always points to a Symbol.id. */
  symbol_id: string;
  /** File where the reference occurs. */
  file: FileId;
  span: Span;
  /** Which ImportEdge bound this name. */
  via_import: {
    from: FileId;
    raw: string;
  };
  /** v1 writes only "identifier_use". Future kinds reserved. */
  kind: "identifier_use";
}

export interface DirEdge {
  /** POSIX, no trailing slash. Root is ".". */
  from_dir: string;
  to_dir: string;
  weight: number;
}

export interface FileFingerprint {
  file: FileId;
  mtime_ms: number;
  size: number;
  /** First 16 hex chars of SHA-256 of file contents. */
  content_hash: string;
  indexer_version: string;
}

export type Collection =
  | "symbols"
  | "imports"
  | "references"
  | "dir_edges"
  | "file_fingerprints";

export interface IndexManifest {
  /** Bump on layout/record-shape changes. Rebuild on mismatch. */
  index_version: number;
  autocontext_version: string;
  project_root: string;
  last_full_build: string;
  file_count: number;
  /** SHA-256 hex digests (or version strings) of loaded tree-sitter grammars. */
  grammar_hashes: Record<string, string>;
}

/** Alias for T11 library exports (plan calls it `Symbol` but that shadows the global). */
export type { IndexSymbol as Symbol };
