# autocontext local code index

Persisted under `.autocontext/index/`. Consumed by impact analysis (T2),
prompt pack retrieval (T3), policy evaluation (T4), MCP navigation (T6),
and the static HTML viewer (T10). This directory is the single seam.

## Precision boundary (v1)

The index stores **only**:

1. **Symbols** — module-scope definitions (functions, classes, consts, types,
   interfaces, enums, Go type specs, Rust items). Emitted by the existing AST
   queries in [src/generator/ast.ts](../generator/ast.ts).
2. **ImportEdges** — one row per `(from_file, raw_module_specifier)` pair.
3. **References** — **import-bound identifier uses only**. A Reference is
   emitted iff the referring identifier is bound by a tracked ImportEdge in
   the same file AND the resolver maps that edge to a concrete file and
   `Symbol.id`. Free identifier uses, member access, call-graph resolution,
   and re-export chains beyond one hop are **out of scope**.
4. **DirEdges** — deterministic directory→directory rollup derived from
   ImportEdges. Persisted for fast reads; recomputed whole on every build.

Downstream consumers (impact, pack, policy) must treat references as
import-scoped. False positives past this boundary poison every downstream
track. See [T1-B plan](../../../.claude/plans/dapper-gathering-parasol/T1-B-graph-builders.md)
for per-language honest-status detail.

## Versioning

`INDEX_VERSION` ([version.ts](version.ts)) is independent of the `.context.yaml`
schema version. Bumping the index version rebuilds `.autocontext/index/`
wholesale; the schema stays at 1. Bumping the grammar hashes in the manifest
also triggers a rebuild so parser drift never yields stale Symbol IDs.

## On-disk layout

```
.autocontext/index/
  manifest.json              # IndexManifest — small, read on every open
  fingerprints.ndjson        # FileFingerprint rows
  symbols/<shard>.ndjson     # IndexSymbol rows, sharded by top-level dir
  imports/<shard>.ndjson     # ImportEdge rows
  references/<shard>.ndjson  # Reference rows
  dir_edges.json             # DirEdge[] — rewritten whole
  .lock                      # advisory file lock (see lock.ts)
  .tmp/                      # scratch for atomic rewrites
```

Shard key = first path segment of the keying file; root files land in
`__root__`. See [shard.ts](shard.ts).

## Concurrency

- Cross-process: advisory `.lock` file in exclusive mode for writers, shared
  mode for readers (MCP server, `context show`).
- In-process: per-shard mutex + per-fingerprint-file mutex serialize writes
  so two parallel `writeFile` calls against the same shard never interleave.
- Every shard write is atomic: write to `.tmp/<stem>.<pid>.<rand>` then
  `fs.rename` into place. A crashed writer leaves a stray tmp file that the
  next open sweeps.

## Not yet indexed

The v1 analyzer supports TypeScript, JavaScript, and Python. Go and Rust
files are scanned by the existing static analysis pipeline for `.context.yaml`
generation but do **not** produce `Symbol` / `ImportEdge` / `Reference` rows in
this index. The tree-sitter queries for Go (`selector_expression` →
package-qualified references) and Rust (`use_declaration` →
`use`-introduced bindings) are spec'd in the T1-B plan; dropping them in is
straightforward when a fixture and precision budget exist. Callers that
consume the index (impact analysis, pack retrieval, policy) should treat
Go and Rust files as "no graph data available" for now.

## Caveats

- **Local filesystems only.** NFS flock semantics are unreliable; NFS-mounted
  repos may see transient inconsistencies.
- **Case-insensitive filesystems** (macOS default) can yield two FileIds
  differing only by case. Accepted as user error.
- **Reference storage cost.** Even with the import-bound boundary, very
  large repos can produce hundreds of thousands of Reference rows. If the
  in-memory open-time cost becomes a problem, the `IndexStore` interface is
  the exit — a SQLite backend can slot in without touching callers.

## Manual inspection

All data is plain JSON / NDJSON. For a quick look:

```sh
cat .autocontext/index/manifest.json
head -1 .autocontext/index/symbols/src.ndjson | python -m json.tool
```

Do not edit these files by hand — `writeFile` / `dropFile` on the store own
the row shape and shard placement.
