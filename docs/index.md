# Local code index

autocontext ships a local code-intelligence index at `.autocontext/index/`, built by `context index` and consumed read-only by every capability that needs graph-level signal: pack ranking, impact analysis, semantic staleness, policy evaluation, and the MCP navigation tools.

The index is deliberately narrow. It records **symbols**, **imports**, and **import-bound references** — nothing more. Free identifiers, member-access chains, dynamic imports, and polymorphic dispatch are not tracked. This is a hard precision boundary, documented throughout the codebase and surfaced via pinned caveats on user-facing outputs.

## Build

```bash
# First build or full rebuild
context index --rebuild

# Incremental (default) — diffs against fingerprints and re-indexes changed files
context index
```

`context init` and a full-tree `context regen` call `context index` automatically. The pre-commit hook also refreshes the index before regenerating context files.

## Layout (NDJSON backend)

```
.autocontext/index/
├── manifest.json              # index_version, autocontext_version, project_root, file_count, grammar_hashes
├── symbols/
│   └── <shard>.ndjson         # one IndexSymbol per line, sharded by top-level directory
├── imports/
│   └── <shard>.ndjson         # one ImportEdge per line
├── references/
│   └── <shard>.ndjson         # one Reference per line (import-bound only)
├── file_fingerprints/
│   └── <shard>.ndjson         # { file, mtime_ms, size, content_hash, indexer_version }
├── dir_edges.json             # rolled-up directory→directory import edges (for pack + impact)
└── bm25/                      # (deferred — in-memory build today)
```

Sharding is by the top-level directory under `src/` (or the project root for flat layouts). This lets readers stream a subset without loading the whole index.

## Record shapes

See `src/index/types.ts` for the authoritative definitions. Highlights:

```ts
interface IndexSymbol {
  id: string;                    // `${fileId}#${name}@${nameByteOffset}`
  file: FileId;                  // project-relative POSIX
  name: string;
  kind: "function" | "class" | "interface" | "type" | "constant" | "enum" | "method" | "variable";
  exported: boolean;
  span: { startLine: number; endLine: number; nameByteOffset: number };
  signature?: string;
  lang: "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs";
}

interface ImportEdge {
  from: FileId;
  raw: string;                   // specifier as written
  resolved_to?: FileId | null;   // best-effort resolution
  symbols: string[];             // imported names, normalized
  kind: "static" | "cjs_require" | "dynamic" | "reexport" | "py_from" | "rust_use";
  line: number;
}

interface Reference {
  symbol_id: string;             // the definition being referenced
  file: FileId;                  // where the reference occurs
  span: { startLine: number; endLine: number; nameByteOffset: number };
  via_import: { from: FileId; raw: string };
  kind: "identifier_use";
}

interface DirEdge {
  from_dir: string;              // POSIX, "." for root
  to_dir: string;
  weight: number;                // count of ImportEdges between the two dirs
}
```

## Versioning

`INDEX_VERSION` is a separate integer from the `.context.yaml` schema's `SCHEMA_VERSION`. It bumps when the index's on-disk layout or record shape changes. A mismatch triggers a rebuild (or a clear `INDEX_VERSION_MISMATCH` error from the read-only reader).

This decoupling is deliberate: index format can evolve quickly without touching the `.context.yaml` contract that downstream users depend on.

## Precision boundary (non-negotiable)

| Layer | What the index records | Explicitly excluded |
|---|---|---|
| Symbols | Top-level declarations emitted by tree-sitter queries (exports + internals) | Methods on classes (v1 opt-out), nested function declarations in some languages, property-style exports |
| ImportEdges | One row per `(from_file, raw_module_specifier)` | Runtime-synthesized specifiers (template literals in `import()`), exotic re-export chains beyond one hop |
| References | **Only** identifier uses that are bound by a static import statement in the same file and resolve to a concrete `Symbol.id` in another file | Free identifier uses, namespace member access, dynamic `import()` / `require()` at runtime, polymorphic dispatch, type-only uses |
| DirEdges | Directory→directory rollup from `ImportEdge.from_dir` → `resolved_to_dir` | N/A (deterministic derivation) |

This boundary is the reason `find_references` and `impact` ship with pinned caveat strings. A zero result is **not** proof of zero callers — it's proof of zero import-bound callers.

## Per-language status

| Language | Index support | Notes |
|---|---|---|
| TypeScript / `.ts` / `.tsx` | Shipped | Tree-sitter via WASM. Precision / recall targets met on the fixture. |
| JavaScript / `.js` / `.jsx` | Shipped | Same analyzer as TS. |
| Python / `.py` | Shipped | Separate analyzer. Precision / recall targets met. |
| Go / `.go` | **Deferred** | Noted in `src/index/README.md`. Tree-sitter grammar is already copied; analyzer queries are specced. |
| Rust / `.rs` | **Deferred** | Same story — grammar copied, analyzer queries specced. |

Go/Rust analyzers are planned for a later minor release; the WASM grammars ship today so adding them is additive work.

## Consumers (read-only)

| Track | Use |
|---|---|
| T2 semantic staleness | `computeSemanticFingerprint` over exported symbols + resolved imports. |
| T2 impact | `computeImpact` walks `getReferencesTo` + `getImporters` from the seed. |
| T3 pack | Graph proximity from `getDirEdges`. Must-include bias from `findSymbolsByName` for symbol seeds. |
| T4 policies | `scanImports` for `forbid_import` / `require_import` / `dependency_boundary`. `findSymbolsByName` for `require_export`. |
| T6 MCP nav | `find_definition`, `find_references`, `find_related` read directly. |
| T10 viewer | Uses `DirEdge` rows to render the dep-graph SVG. |
| T12 bench | Ground-truth for `find-definition`, `find-callers`, `impact-of-change` task categories. |

All consumers open the index with `{ readOnly: true, autoRebuild: false }`. MCP tools that need the index and find it missing return a structured error — they never auto-build.

## Library usage

```ts
import { openIndex } from "autocontext";

const store = await openIndex(process.cwd(), { readOnly: true, autoRebuild: false });
try {
  const defs = await store.findSymbolsByName("buildPack");
  for await (const edge of store.scanImports({ fromGlob: "src/pack/**" })) {
    console.log(edge.from, "→", edge.resolved_to ?? edge.raw);
  }
} finally {
  await store.close();
}
```

`openIndex` is `@stability experimental` — the pluggable `IndexStore` interface is the long-term contract, but the NDJSON backend's internal layout may still evolve. See [docs/library.md](library.md).

## Gitignore

`.autocontext/` holds artifacts only (index shards, LLM cache, policy results). `context init` appends `.autocontext/` to `.gitignore` on first run; `context doctor` warns when the entry is missing in an existing checkout.

## Limitations

- Recall for cross-package imports beyond one hop depends on the resolver. Npm packages are resolved, not walked into. Monorepos with symlinked packages work because tree-sitter operates on file text.
- Methods on classes are intentionally excluded from the symbol table in v1 — they change too often for the precision budget. Class definitions themselves are recorded.
- Declaration files (`.d.ts`) are indexed for `Symbol` rows but filtered out of `find-definition` ground truth in benchmarks.
